#!/usr/bin/env bash
set -euo pipefail

# Read service name from environment or default
MC_SERVICE_NAME="${MC_SERVICE_NAME:-minecraft.service}"

sudo systemctl restart "$MC_SERVICE_NAME"
