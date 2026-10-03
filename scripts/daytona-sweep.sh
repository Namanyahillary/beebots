#!/bin/bash
# Daytona burst research: spin a disposable sandbox, run a job, print the table, destroy it.
# The trading machine stays clean; sweeps parallelize; nothing lives past the run.
# Usage: scripts/daytona-sweep.sh <name> <local-script.py> [args...]
#   The script is uploaded through the exec channel itself (base64 heredoc) — no repo
#   clone, no credentials leave this machine. Needs DAYTONA_API_KEY in .env (gitignored).
# Always destroys the sandbox, even on failure (trap). Verify: list shows no residue.
set -u
cd "$(dirname "$0")/.."
[ -f .env ] && set -a && source .env && set +a
name="${1:?sweep name}"; script="${2:?local python script}"; shift 2
[ -f "$script" ] || { echo "REFUSED: no such script $script"; exit 1; }
: "${DAYTONA_API_KEY:?DAYTONA_API_KEY missing from .env}"
API="https://app.daytona.io/api"
H=(-H "Authorization: Bearer $DAYTONA_API_KEY" -H "Content-Type: application/json")

ID=""
cleanup() {
  if [ -n "$ID" ]; then
    curl -s -m 15 -X DELETE "${H[@]}" "$API/sandbox/$ID" -o /dev/null
    echo "destroyed $ID" >&2
  fi
}
trap cleanup EXIT

ID=$(curl -s -m 20 -X POST "${H[@]}" -d "{\"name\":\"sweep-$name\"}" "$API/sandbox" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
[ -n "$ID" ] || { echo "REFUSED: sandbox create failed"; exit 1; }
echo "sandbox $ID ($name)" >&2
for _ in $(seq 1 30); do
  S=$(curl -s -m 10 "${H[@]}" "$API/sandbox/$ID" | python3 -c "import json,sys; print(json.load(sys.stdin).get('state'))")
  [ "$S" = "started" ] && break
  sleep 10
done
[ "$S" = "started" ] || { echo "REFUSED: sandbox never started ($S)"; exit 1; }

ORG=$(curl -s -m 10 "${H[@]}" "$API/sandbox/$ID" | python3 -c "import json,sys; print(json.load(sys.stdin).get('organizationId'))")
PROXY="https://proxy.app-eu.daytona.io/toolbox"
B64=$(base64 -w0 "$script")
run() {
  curl -s -m 120 -X POST -H "Authorization: Bearer $DAYTONA_API_KEY" -H "Content-Type: application/json" \
    -H "X-Daytona-Organization-ID: $ORG" -d "{\"command\": $(printf '%s' "$1" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')}" \
    "$PROXY/$ID/process/execute"
}
# Upload: decode the payload into /tmp/job.py through the exec channel itself.
run "echo '$B64' | base64 -d > /tmp/job.py && echo UPLOADED" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d.get('exitCode') == 0, d; print('uploaded', file=sys.stderr)"
# Execute with any extra args, print stdout.
ARGS=$(python3 -c 'import shlex,sys; print(" ".join(shlex.quote(a) for a in sys.argv[1:]))' "$@")
run "python3 /tmp/job.py $ARGS" | python3 -c "
import json,sys
d = json.load(sys.stdin)
sys.stdout.write(d.get('result') or '')
if d.get('exitCode') != 0: sys.exit(1)
"
