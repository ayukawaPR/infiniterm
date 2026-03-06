#!/bin/bash
cd "$(dirname "$0")"
open -a "$(pwd)/node_modules/electron/dist/Electron.app" --args "$(pwd)"
