"""Discord standup commands (/daily, /standup, /checking) running inside the Hermes gateway.

Wired through ctx.register_platform_handler("discord", ...), which hands us the gateway's live
discord.py Bot after it connects. The commands are registered as GUILD commands for the configured
server and synced on their own: Hermes's global command sync only diffs global commands, so it
never deletes ours, and ours never count against its 100-command global cap.

Flow: the command opens a modal (prefilled with today's answers when correcting); on submit the
answers are saved to pm.db (one row per user per local day, so a second submission is an update,
not a duplicate), the user gets an ephemeral receipt, and the post in the standup channel is
created or, on correction, edited in place. Nothing from the modal is shown publicly except
through that post.
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone

import pm_core as C
from pm_store import open_store

try:  # module-level so discord.py can resolve the callbacks' string annotations
    import discord
    from discord import app_commands
except ImportError:  # unit tests run without discord.py
    discord = app_commands = None

logger = logging.getLogger("project_manager.standup")

TEMPLATE_TITLE = "DAILY STATUS"
Q1, Q2, Q3 = "¿Qué completaste ayer?", "¿Qué trabajarás hoy?", "¿Tienes algún bloqueo o riesgo?"


def _task_index(store) -> dict[str, dict]:
    return {tid: t for tid, t in store.task_states().items()}


def build_mentions(cfg: dict, directory: C.Directory, can_everyone: bool) -> tuple[bool, list[str], str | None]:
    """(everyone, targeted_ids, fallback_note) for one published submission."""
    mode = cfg["discord"]["standup"]["notification_mode"]
    if mode == "all_team":
        if can_everyone:
            return True, [], None
        return False, [], "bot lacks permission to mention @everyone; published without it"
    if mode == "targeted":
        ids = []
        for key in cfg["discord"]["standup"].get("targeted_recipients") or []:
            _, uid = directory.mention_key(key, "standup targeted recipient")
            if uid:
                ids.append(uid)
        return False, ids, None
    return False, [], None  # summary (mass mention happens once, in the daily summary) / quiet


def setup(bot, adapter=None) -> None:
    """Platform handler factory: register the commands on the live bot and sync them."""
    if discord is None:
        logger.error("project_manager: discord.py unavailable; standup commands not registered")
        return

    try:
        cfg = C.load_config()
    except Exception as e:
        logger.error("project_manager: standup commands not registered, config error: %s", e)
        return
    if not cfg["enabled"] or not cfg["discord"].get("guild_id"):
        logger.info("project_manager: standups disabled or discord.guild_id unset")
        return
    guild = discord.Object(id=int(cfg["discord"]["guild_id"]))

    class StandupModal(discord.ui.Modal):
        def __init__(self, existing: dict | None):
            super().__init__(title=TEMPLATE_TITLE + (" (corrección)" if existing else ""), timeout=900)
            ex = existing or {}
            self.completed = discord.ui.TextInput(label=Q1, style=discord.TextStyle.paragraph, max_length=1000,
                                                  required=True, default=ex.get("completed"))
            self.planned = discord.ui.TextInput(label=Q2, style=discord.TextStyle.paragraph, max_length=1000,
                                                required=True, default=ex.get("planned"))
            self.blockers = discord.ui.TextInput(label=Q3, style=discord.TextStyle.paragraph, max_length=1000,
                                                 required=False, default=ex.get("blockers"),
                                                 placeholder="Ninguno")
            for item in (self.completed, self.planned, self.blockers):
                self.add_item(item)

        async def on_submit(self, interaction: discord.Interaction) -> None:
            await interaction.response.defer(ephemeral=True, thinking=True)
            try:
                note = await handle_submission(interaction, str(self.completed.value), str(self.planned.value),
                                               str(self.blockers.value or ""))
                await interaction.followup.send(note, ephemeral=True)
            except Exception as e:
                logger.exception("standup submission failed")
                await interaction.followup.send(
                    "⚠️ No se pudo guardar o publicar tu daily status. Inténtalo de nuevo; el equipo de "
                    f"operaciones fue notificado. ({e.__class__.__name__})", ephemeral=True)

        async def on_error(self, interaction: discord.Interaction, error: Exception) -> None:
            logger.exception("standup modal error", exc_info=error)

    async def handle_submission(interaction, completed: str, planned: str, blockers: str) -> str:
        cfg = C.load_config()  # re-read so admins can change mode/channels without a restart
        store = open_store(C.DATA_DIR)
        now = datetime.now(timezone.utc)
        day = C.local_date(now, C.tz(cfg)).isoformat()
        uid = str(interaction.user.id)
        row, is_update = store.save_standup(uid, day, str(interaction.guild_id), completed, planned, blockers, now)
        directory = C.Directory(cfg)
        channel_id = cfg["discord"].get("standup_channel_id")
        if not channel_id:
            store.log("warning", "standup_unpublished", f"{uid} {day}: standup_channel_id not configured")
            return "✅ Daily status guardado, pero no hay canal de publicación configurado (aviso enviado a operaciones)."
        channel = bot.get_channel(int(channel_id)) or await bot.fetch_channel(int(channel_id))
        me = channel.guild.me if getattr(channel, "guild", None) else None
        can_everyone = bool(me and channel.permissions_for(me).mention_everyone)
        everyone, targeted, note = build_mentions(cfg, directory, can_everyone)
        if note:
            store.log("warning", "everyone_fallback", f"standup {uid} {day}: {note}")
        if is_update:
            everyone = False  # a correction never re-pings the team
        msg = C.build_standup_post(cfg, row, _task_index(store), everyone, targeted, is_update)
        allowed = discord.AllowedMentions(everyone=everyone, users=[discord.Object(int(i)) for i in msg.user_ids],
                                          roles=False, replied_user=False)
        chunks = C.split_message(msg.text)
        old_ids = json.loads(row.get("message_ids") or "[]")
        ids: list[str] = []
        if is_update and old_ids and len(old_ids) == len(chunks):
            for mid, chunk in zip(old_ids, chunks):
                m = await channel.fetch_message(int(mid))
                await m.edit(content=chunk, allowed_mentions=discord.AllowedMentions.none())
                ids.append(mid)
        else:
            for chunk in chunks:
                m = await channel.send(chunk, allowed_mentions=allowed)
                ids.append(str(m.id))
            for mid in old_ids if is_update else []:
                try:
                    await (await channel.fetch_message(int(mid))).delete()
                except Exception:
                    pass
        store.set_standup_messages(uid, day, str(channel.id), ids)
        where = f"<#{channel.id}>"
        return (f"✏️ Tu daily status de hoy fue actualizado en {where}." if is_update
                else f"✅ Daily status recibido y publicado en {where}. Puedes corregirlo usando el comando otra vez.")

    async def open_modal(interaction: discord.Interaction) -> None:
        cfg = C.load_config()
        if str(interaction.guild_id) != str(cfg["discord"]["guild_id"]):
            await interaction.response.send_message("Este comando solo funciona en el servidor del equipo.",
                                                    ephemeral=True)
            return
        store = open_store(C.DATA_DIR)
        day = C.local_date(datetime.now(timezone.utc), C.tz(cfg)).isoformat()
        await interaction.response.send_modal(StandupModal(store.standup(str(interaction.user.id), day)))

    tree = bot.tree
    names = cfg["discord"]["standup"]["commands"]
    for name in names:
        cmd = app_commands.Command(name=name, description="Enviar o corregir tu daily status del día",
                                   callback=open_modal)
        tree.add_command(cmd, guild=guild, override=True)

    async def _sync():
        try:
            synced = await tree.sync(guild=guild)
            logger.info("project_manager: synced %d guild command(s): %s", len(synced),
                        ", ".join(c.name for c in synced))
        except Exception:
            logger.exception("project_manager: guild command sync failed")

    try:
        asyncio.get_running_loop().create_task(_sync())
    except RuntimeError:
        logger.warning("project_manager: no running loop; guild commands will sync on next connect")
