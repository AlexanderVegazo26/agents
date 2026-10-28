"""Coach reply capture, running inside the Hermes gateway (same platform-handler hook as the standup
commands). A reply to one of the coach's Discord messages is stored, documented in the vault and
quiets the questions it answers (coach.record_reply). Only configured team members count; the text
is stored as data and never executed."""

from __future__ import annotations

import logging
from datetime import datetime, timezone

import pm_core as C

logger = logging.getLogger("project_manager.coach")


def setup(bot, adapter=None) -> None:
    try:
        import coach
        cfg, ccfg = C.load_config(), coach.load_coach_cfg()
    except Exception as e:
        logger.error("project_manager: coach reply capture not registered: %s", e)
        return
    if not cfg["enabled"] or not ccfg["enabled"]:
        return
    team = {u["discord_user_id"]: u["display_name"] for u in cfg.get("users") or []
            if u.get("enabled", True) and u.get("discord_user_id")}

    async def on_message(message) -> None:
        ref = getattr(message, "reference", None)
        if message.author.bot:
            return
        author = str(message.author.id)
        if author not in team:
            return
        try:
            db = coach.Db(C.DATA_DIR / "coach.db")
            ref_id = ref.message_id if ref and ref.message_id else None
            if ref_id is None and message.guild is None:      # a DM needs no explicit reply: it answers the last coach DM
                ref_id = db.latest_msg_in(message.channel.id)
            if ref_id is None:
                return
            res = coach.record_reply(db, ccfg, str(ref_id), author, team[author],
                                     message.content or "", datetime.now(timezone.utc))
        except Exception:
            logger.exception("project_manager: coach reply capture failed")
            return
        if res is None:
            return
        outcomes = {r["outcome"] for r in res["items"]} if isinstance(res["items"], list) else {"unmapped"}
        emoji = "🗑️" if outcomes == {"dismissed"} else "🤔" if outcomes == {"unmapped"} else "✅"
        try:
            await message.add_reaction(emoji)
            if outcomes == {"unmapped"}:
                await message.reply("Lo guardé, pero no sé a qué ticket corresponde. Responde con «1: …», «2: …».",
                                    mention_author=False)
        except Exception:
            logger.warning("project_manager: could not react to coach reply (missing permission?)")

    bot.add_listener(on_message, "on_message")
    logger.info("project_manager: coach reply capture registered")
