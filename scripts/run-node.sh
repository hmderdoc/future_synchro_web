#!/bin/bash
# Wrapper that sources NVM so node resolves regardless of version.
# Used by system.exec() calls from Synchronet (which has a minimal PATH).
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
exec node "$@"
