#!/bin/sh
# Writes the list of proxies whose X-Forwarded-For nginx believes. EMUCAT_TRUSTED_PROXIES is a
# space- or comma-separated list of addresses or CIDR ranges, normally the external HTTPS proxy as this
# container sees it. Empty means trust no one: nginx then uses the connecting address as the client.
set -eu

output=/run/emucat-web/real-ip.conf
list=$(printf '%s' "${EMUCAT_TRUSTED_PROXIES:-}" | tr ',' ' ')

{
    echo "# Generated at container start from EMUCAT_TRUSTED_PROXIES."
    found=0
    for entry in $list; do
        # Addresses and CIDR ranges only: anything else would be nginx syntax from the environment.
        case "$entry" in
            *[!0-9a-fA-F.:/]*)
                echo "40-emucat-real-ip.sh: ignoring invalid trusted proxy entry" >&2
                continue
                ;;
        esac
        echo "set_real_ip_from $entry;"
        found=1
    done
    if [ "$found" -eq 1 ]; then
        echo "real_ip_header X-Forwarded-For;"
        echo "real_ip_recursive on;"
    fi
} >"$output"
