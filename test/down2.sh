#!/usr/bin/env bash
cd "$(dirname "$0")"; [ -f .run/pids ] && kill $(cat .run/pids) 2>/dev/null; sleep 0.5; true
