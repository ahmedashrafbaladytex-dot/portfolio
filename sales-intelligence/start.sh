#!/bin/sh
cd "$(dirname "$0")" || exit 1
[ -f settings.env ] || { cp settings.example.env settings.env; echo "املا settings.env وشغل تاني"; exit 0; }
[ -d node_modules ] || npm install --no-audit --no-fund
exec node bot.js
