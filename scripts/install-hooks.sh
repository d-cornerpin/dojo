#!/bin/sh
# Install repo git hooks (run once per clone).
cp scripts/hooks/pre-commit .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit && echo "hooks installed"
