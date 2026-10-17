"""hermes-proactive: proactive-agent toolkit for Hermes.

Ports the strongest proactive patterns from the CopilotKit open-agent repos:

- OpenMuse  -> condition monitors, goals/milestones, ideas-style suggestions
- OpenBot   -> event triggers (webhook/HMAC), proactive scan engine
- OpenDots  -> durable scheduled-task state, dedup/lease semantics

Everything is stdlib-only Python so cron jobs can run it without a venv.
"""

__version__ = "0.1.0"
