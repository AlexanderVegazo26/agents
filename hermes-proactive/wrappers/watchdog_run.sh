#!/usr/bin/env bash
# proactive-watchdog: print monitor transition lines only when a watch flips
# state. With --no-agent, Hermes delivers this stdout verbatim; empty = silent.
exec python3 "$HOME/.hermes/scripts/condition_monitor.py" run-all --mode transitions
