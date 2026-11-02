#!/usr/bin/env bash
set -Eeuo pipefail

# The caller supplies root access; this script never changes privilege tooling.
if (( EUID != 0 )); then
  printf '%s\n' 'Run install-telemetry.sh as root.' >&2
  exit 1
fi
umask 077
export LC_ALL=C

fail() { failed_command="preflight: $*"; failed_line=${BASH_LINENO[0]}; printf 'install-telemetry: %s\n' "$*" >&2; exit 1; }
for command in docker systemctl systemd-analyze curl jq tar flock runuser realpath stat getent ss mktemp install cp mv rm chmod chown date env cmp df find; do
  command -v "$command" >/dev/null || fail "Missing prerequisite: $command"
done
exec 9>/run/junco-telemetry-install.lock
flock -n 9 || fail 'Another telemetry installation is running.'

# NUL-delimited realpath also detects paths ending in a newline.
[[ ${BASH_SOURCE[0]} != *$'\n'* && ${BASH_SOURCE[0]} != *$'\r'* ]] || fail 'Newlines in paths are unsupported.'
IFS= read -r -d '' script < <(realpath -ze -- "${BASH_SOURCE[0]}")
root=${script%/*}
[[ $root != *$'\n'* && $root != *$'\r'* ]] || fail 'Newlines in paths are unsupported.'
owner_uid=$(stat -c %u -- "$root")
(( owner_uid != 0 )) || fail 'The checkout must have a non-root owner.'
passwd=$(getent passwd "$owner_uid") || fail 'The checkout owner has no passwd entry.'
IFS=: read -r owner _ uid gid _ owner_home _ <<< "$passwd"
[[ $uid == "$owner_uid" && -d $owner_home ]] || fail 'The checkout owner has no usable home directory.'
[[ $owner_home != *$'\n'* && $owner_home != *$'\r'* ]] || fail 'Newlines in paths are unsupported.'
IFS= read -r -d '' docker < <(realpath -ze -- "$(command -v docker)")
[[ $docker != *$'\n'* && $docker != *$'\r'* ]] || fail 'Newlines in paths are unsupported.'
IFS= read -r -d '' opik_root < <(realpath -ze -- "$root/../opik")
[[ $opik_root != *$'\n'* && $opik_root != *$'\r'* ]] || fail 'Newlines in paths are unsupported.'
upstream=$opik_root/deployment/docker-compose/docker-compose.yaml
compose_file=$root/docker-compose.yml
legacy_grafana=''
grafana_bind=''
adopt_bind=0
baseline_receipt=${JUNCO_OPIK_BASELINE_RECEIPT:-}
unit_dir=/etc/systemd/system
managed_unit=junco-telemetry.service
state_dir=/var/lib/junco-telemetry
marker='# Installed by junco/install-telemetry.sh'
backup=''
work=$(mktemp -d /run/junco-telemetry-install.XXXXXXXX)
cutover=0
complete=0
sdk_changed=0
managed_present=0
reinstall=0
failed_command='installation preflight'
failed_line=0
unit_tmp=''
config_tmp=''
state_tmp=''
rollback_dir=''
state_changed=0
rollback_dropin=/run/systemd/system/junco-telemetry.service.d/90-install-rollback.conf
legacy_units=(grafana-compose.service grafana.service opik.service)
volumes=(grafana_data opik-opik_mysql opik-opik_redis-data opik-opik_clickhouse opik-opik_clickhouse-server opik-opik_clickhouse-config opik-opik_zookeeper opik-opik_minio-data)
services=(grafana grafana-proxy prometheus mysql redis clickhouse-init zookeeper clickhouse minio mc backend python-backend frontend)
declare -A old_enabled old_active old_present

# Root, checkout owner and systemd deliberately use the same local Docker socket.
docker_root() { env -u DOCKER_CONTEXT -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH -u DOCKER_API_VERSION -u COMPOSE_PROFILES DOCKER_HOST=unix:///var/run/docker.sock "$docker" "$@"; }
docker_owner() (
  cd -- "$root"
  runuser -u "$owner" -- env -i HOME="$owner_home" USER="$owner" LOGNAME="$owner" PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin DOCKER_HOST=unix:///var/run/docker.sock "$docker" "$@"
)
compose() { docker_owner compose -p junco-telemetry -f "$compose_file" "$@"; }
unit_quote() {
  local value=$1
  value=${value//%/%%}
  if [[ ${2:-} == exec ]]; then
    value=${value//\\/\\\\}; value=${value//\"/\\\"}; value=${value//\$/\$\$}
    printf '"%s"' "$value"
  else
    # User/WorkingDirectory take the whole value, unlike ExecStart's quoted argv.
    printf '%s' "$value"
  fi
}
atomic_copy() {
  local source=$1 destination=$2 temporary
  temporary=$(mktemp "${destination%/*}/.junco-restore.XXXXXXXX") || return
  cp --preserve=all -- "$source" "$temporary" && mv -fT -- "$temporary" "$destination" || { rm -f -- "$temporary"; return 1; }
}
capture_baseline() {
  local destination=$1
  curl -q --noproxy '*' --fail --silent --show-error --max-time 30 --get http://localhost:5173/api/v1/private/projects --data-urlencode 'name=junco-swebench-smoke' > "$destination/baseline-project.json"
  curl -q --noproxy '*' --fail --silent --show-error --max-time 30 --get http://localhost:5173/api/v1/private/traces/ --data-urlencode 'project_id=01a19a1d-6d3d-775d-bce3-6e74e89bdca3' --data-urlencode 'size=100' > "$destination/baseline-traces.json"
  curl -q --noproxy '*' --fail --silent --show-error --max-time 30 --get http://localhost:5173/api/v1/private/spans/ --data-urlencode 'project_id=01a19a1d-6d3d-775d-bce3-6e74e89bdca3' --data-urlencode 'trace_id=01a19a39-5c23-72ab-ac69-03b59745720b' --data-urlencode 'size=100' > "$destination/baseline-spans.json"
}
normalize_baseline() {
  local directory=$1
  jq -eS '[.content[] | select(.id == "01a19a1d-6d3d-775d-bce3-6e74e89bdca3" and .name == "junco-swebench-smoke") | {id,name,created_at}] | if length == 1 then . else error("baseline project missing") end' "$directory/baseline-project.json" > "$directory/project.identity.json"
  jq -eS '[.content[] | select(.id == "01a19a39-5c23-72ab-ac69-03b59745720b" and .project_id == "01a19a1d-6d3d-775d-bce3-6e74e89bdca3" and .name == "preflight" and .start_time == "2026-11-02T03:06:52.835Z" and .end_time == "2026-11-02T03:06:57.523Z" and .span_count == 8) | {id,project_id,name,start_time,end_time,input,output,metadata,created_at,created_by,source,environment}] | if length == 1 then . else error("baseline trace missing or incomplete") end' "$directory/baseline-traces.json" > "$directory/trace.identity.json"
  jq -eS '.content | sort_by(.id) | if length == 8 and all(.[]; .project_id == "01a19a1d-6d3d-775d-bce3-6e74e89bdca3" and .trace_id == "01a19a39-5c23-72ab-ac69-03b59745720b" and .start_time != null and .end_time != null) and (map(.id) == ["01a19a39-5c2d-7648-a054-9706086b967a","01a19a39-5c2e-752e-bf1c-66f0ae1a7abb","01a19a39-623b-70f3-8a47-e5d0327ba793","01a19a39-623c-76e7-aa72-4e3a5d4e90dc","01a19a39-623d-74cf-9a11-426addc33253","01a19a39-623e-7184-b6d5-d98ae9fd6030","01a19a39-6e72-7558-92de-b30251df573a","01a19a39-6e73-767c-9c0a-60e39ecaa3e4"]) then map({id,project_id,trace_id,parent_span_id,name,type,start_time,end_time,input,output,metadata,created_at,created_by,source,environment}) else error("baseline eight spans missing or incomplete") end' "$directory/baseline-spans.json" > "$directory/spans.identity.json"
}
compare_baseline() {
  local previous=$1 current=$2 kind
  for kind in project trace spans; do
    jq -e --slurpfile previous "$previous/$kind.identity.json" '. == $previous[0]' "$current/$kind.identity.json" >/dev/null || fail "Preserved Opik baseline $kind changed."
  done
}
rollback_errors=0
recover() { "$@" || { printf 'Rollback command failed:' >&2; printf ' %q' "$@" >&2; printf '\n' >&2; rollback_errors=1; }; }
restore_enablement() {
  local name=$1
  recover systemctl disable "$name"
  case ${old_enabled[$name]} in
    enabled) recover systemctl enable "$name" ;;
    enabled-runtime) recover systemctl enable --runtime "$name" ;;
  esac
}
rollback() {
  printf 'Cutover failed; restoring previous workloads. Backups: %s\n' "$backup" >&2
  # Disable before restoring anything: a failed ExecStartPre must not keep retrying.
  if [[ -e $unit_dir/$managed_unit ]]; then
    recover systemctl disable "$managed_unit"
    recover systemctl stop "$managed_unit"
  fi
  recover docker_root compose -p junco-telemetry -f "$backup/new-compose.json" stop --timeout 120
  if (( sdk_changed )); then recover atomic_copy "$backup/opik.config" "$sdk_config"; fi
  for name in "${legacy_units[@]}" "$managed_unit"; do
    if [[ ${old_present[$name]} == 1 ]]; then
      recover atomic_copy "$backup/$name" "$unit_dir/$name"
    elif [[ $name == "$managed_unit" ]]; then
      recover rm -f -- "$unit_dir/$name"
    fi
  done
  recover systemctl daemon-reload
  for name in "${legacy_units[@]}"; do
    [[ ${old_present[$name]} == 1 ]] || continue
    restore_enablement "$name"
    # These units may require an absent docker.service. Compose below restores
    # detached workloads independently of their historical failed unit state.
  done
  if (( managed_present )); then
    restore_enablement "$managed_unit"
    recover atomic_copy "$backup/old-managed-compose.json" "$state_dir/compose.json"
    # A saved render is authoritative for rollback, not edited checkout files.
    # Override just this start, then restore the prior unit's normal boot contract.
    rollback_dir=$(mktemp -d /run/junco-telemetry-rollback.XXXXXXXX)
    recover chown "$uid:$gid" "$rollback_dir"
    recover install -o "$uid" -g "$gid" -m 0600 "$backup/old-managed-compose.json" "$rollback_dir/compose.json"
    recover install -d -m 0755 "${rollback_dropin%/*}"
    {
      printf '[Service]\nExecStart=\nExecStart='
      unit_quote "$docker" exec
      printf ' compose -p junco-telemetry -f '
      unit_quote "$rollback_dir/compose.json" exec
      printf ' up -d --no-build --pull never --wait --wait-timeout 600\n'
      printf 'ExecStop=\nExecStop='
      unit_quote "$docker" exec
      printf ' compose -p junco-telemetry -f '
      unit_quote "$rollback_dir/compose.json" exec
      printf ' stop --timeout 120\n'
      printf 'Restart=no\n'
    } > "$rollback_dropin"
    recover systemctl daemon-reload
    if systemctl restart "$managed_unit"; then
      recover rm -f -- "$rollback_dropin"
      recover systemctl daemon-reload
      recover rm -rf -- "$rollback_dir"
      rollback_dir=''
    else
      printf 'Prior service restart failed; retained rollback override %s (Restart=no).\n' "$rollback_dropin" >&2
      rollback_errors=1
    fi
  else
    for project in grafana opik-opik; do
      mapfile -t running_services < "$backup/$project.running-services"
      (( ${#running_services[@]} )) || continue
      recover docker_root compose -p "$project" -f "$backup/$project-compose.json" up -d --no-build --pull never --no-deps "${running_services[@]}"
    done
  fi
  (( rollback_errors == 0 )) || printf 'Some rollback operations failed; saved configs and archives are retained for recovery.\n' >&2
  if (( ! managed_present && state_changed )); then
    recover rm -f -- "$state_dir/installed" "$state_dir/compose.json"
  fi
  printf '%s\n' 'Volume archives were NOT restored over potentially newer data.' >&2
}
finish() {
  local status=$?
  trap - EXIT ERR INT TERM
  set +e
  if (( ! complete && status != 0 )); then
    printf 'Failed command (line %s): %s\n' "$failed_line" "$failed_command" >&2
    (( cutover )) && rollback
    [[ -z $backup ]] || printf 'Retained backups: %s\n' "$backup" >&2
  fi
  [[ -z $unit_tmp ]] || rm -f -- "$unit_tmp"
  [[ -z $config_tmp ]] || rm -f -- "$config_tmp"
  [[ -z $state_tmp ]] || rm -f -- "$state_tmp"
  rm -rf -- "$work"
  exit "$status"
}
trap 'failed_command=$BASH_COMMAND; failed_line=$LINENO' ERR
trap finish EXIT
trap 'failed_command="received SIGINT"; exit 130' INT
trap 'failed_command="received SIGTERM"; exit 143' TERM

[[ -d /run/systemd/system ]] || fail 'systemd is not running on this host.'
systemctl show --property=SystemState --value >/dev/null
docker_root info >/dev/null
docker_owner info >/dev/null
docker_owner compose version >/dev/null
for asset in "$compose_file" "$root/telemetry/opik.override.yml" "$root/telemetry/prometheus.yml" "$root/telemetry/grafana-datasources.yml" "$root/telemetry/grafana-proxy.conf" "$upstream" "$opik_root/deployment/docker-compose/nginx_default_local.conf" "$opik_root/deployment/docker-compose/clickhouse_config/additional_config.xml" "$opik_root/deployment/docker-compose/clickhouse_config/users.d/enable_time_type.xml" "$opik_root/deployment/docker-compose/clickhouse_config/users.d/distributed_insert_queue.xml"; do
  [[ -f $asset && -r $asset ]] || fail "Missing included deployment asset: $asset"
  runuser -u "$owner" -- test -r "$asset" || fail "Checkout owner cannot read asset: $asset"
done
compose config -q
compose config --format json > "$work/new-compose.json"
jq -e '.name == "junco-telemetry"' "$work/new-compose.json" >/dev/null || fail 'Compose must own exactly project junco-telemetry.'
if jq -e '.services["minio-init"] != null' "$work/new-compose.json" >/dev/null; then
  services+=(minio-init)
  jq -e '.services.minio.depends_on["minio-init"].condition == "service_completed_successfully" and any(.services["minio-init"].volumes[]; .type == "volume" and .source == "minio-data" and .target == "/data")' "$work/new-compose.json" >/dev/null || fail 'Upstream minio-init dependency/store is not preserved.'
fi
jq -e --argjson expected "$(printf '%s\n' "${services[@]}" | jq -R . | jq -s 'sort')" '(.services | keys | sort) == $expected' "$work/new-compose.json" >/dev/null || fail 'Unexpected active Compose services.'
jq -e '[.services | to_entries[] | .key as $service | .value.ports[]? | {service:$service,target,published,host_ip}] | sort_by(.published) | length == 3 and .[0].service == "frontend" and .[0].target == 5173 and .[0].published == "5173" and .[1].service == "grafana-proxy" and .[1].target == 80 and .[1].published == "8000" and .[2].service == "prometheus" and .[2].target == 9090 and .[2].published == "8001" and (map(.host_ip) | unique | length == 1)' "$work/new-compose.json" >/dev/null || fail 'Unexpected telemetry port publications.'
jq -e '.services.grafana.environment | .GF_AUTH_ANONYMOUS_ENABLED == "true" and .GF_AUTH_ANONYMOUS_ORG_ROLE == "Admin" and .GF_AUTH_BASIC_ENABLED == "false" and .GF_AUTH_DISABLE_LOGIN_FORM == "true"' "$work/new-compose.json" >/dev/null || fail 'Anonymous Grafana configuration changed.'
jq -e '.services.prometheus.image == "prom/prometheus:v3.15.1" and (.services.prometheus.command | index("--web.enable-otlp-receiver")) != null and any(.services.prometheus.volumes[]; .source == "prometheus_data" and .target == "/prometheus") and .volumes.prometheus_data.name == "junco-telemetry_prometheus_data" and .services["python-backend"].environment.OPIK_REVERSE_PROXY_URL == "http://frontend:5173/api"' "$work/new-compose.json" >/dev/null || fail 'Prometheus storage/OTLP or internal Opik routing changed.'
for service in "${services[@]}"; do
  jq -e --arg service "$service" '.services[$service] | . != null and ((.profiles // []) | length == 0) and .build == null and (.image | type == "string")' "$work/new-compose.json" >/dev/null || fail "Missing/default-profile/image-only service: $service"
done
while IFS= read -r -d '' asset; do
  [[ $asset != *$'\n'* && $asset != *$'\r'* ]] || fail 'Newlines in bind-mount paths are unsupported.'
  [[ -e $asset ]] || fail "Missing bind-mount asset: $asset"
  runuser -u "$owner" -- test -r "$asset" || fail "Checkout owner cannot read bind mount: $asset"
done < <(jq -j '[.services | to_entries[] | select((.value.profiles // []) | length == 0) | .value.volumes[]? | select(.type == "bind") | .source] | unique[] | ., "\u0000"' "$work/new-compose.json")

for name in "${legacy_units[@]}" "$managed_unit"; do
  path=$unit_dir/$name
  [[ ! -L $path ]] || fail "Refusing a symlinked service unit: $path"
  fragment=$(systemctl show "$name" --property=FragmentPath --value)
  [[ -z $fragment || $fragment == "$path" ]] || fail "Unexpected service unit location: $fragment"
  dropins=$(systemctl show "$name" --property=DropInPaths --value)
  [[ -z $dropins ]] || fail "Unexpected service drop-in for $name: $dropins"
  names=$(systemctl show "$name" --property=Names --value)
  [[ -z $names || $names == "$name" ]] || fail "Unexpected service alias for $name: $names"
  triggers=$(systemctl show "$name" --property=TriggeredBy --value)
  [[ -z $triggers ]] || fail "Unexpected timer/socket activation for $name: $triggers"
  old_present[$name]=0
  [[ ! -e $path ]] || old_present[$name]=1
  old_enabled[$name]=$(systemctl is-enabled "$name" 2>/dev/null || true)
  old_active[$name]=$(systemctl is-active "$name" 2>/dev/null || true)
  case ${old_enabled[$name]} in enabled|enabled-runtime|disabled|static|indirect|not-found|'') ;; *) fail "Unsupported previous enablement for $name: ${old_enabled[$name]}" ;; esac
done
if [[ ${old_present[$managed_unit]} == 1 ]]; then
  found=0
  while IFS= read -r line; do [[ $line != "$marker" ]] || found=1; done < "$unit_dir/$managed_unit"
  (( found )) || fail "Existing $managed_unit was not installed by Junco."
  managed_present=1
  if [[ -f $state_dir/installed && -f $state_dir/compose.json ]]; then
    IFS= read -r installed_root < "$state_dir/installed"
    [[ $installed_root == "$root" ]] || fail 'Managed service belongs to a different checkout.'
    jq -e '.name == "junco-telemetry"' "$state_dir/compose.json" >/dev/null || fail 'Previous managed Compose state is invalid.'
    reinstall=1
  else
    fail 'Managed unit has no last-successful configuration; recover it before reinstalling.'
  fi
fi
[[ ! -e $rollback_dropin ]] || fail "A previous rollback override needs attention: $rollback_dropin"
[[ ! -L $state_dir && ! -L /var/backups/junco-telemetry ]] || fail 'Refusing symlinked installer state/backup directories.'
if [[ -d $state_dir ]]; then
  [[ $(stat -c %u -- "$state_dir") == 0 && $(stat -c %a -- "$state_dir") == 700 ]] || fail 'Installer state must be root-owned and mode 0700.'
  (( managed_present )) || [[ ! -e $state_dir/installed && ! -e $state_dir/compose.json ]] || fail 'Previous installer state exists without its managed unit.'
fi

docker_root ps -aq > "$work/container-ids"
mapfile -t container_ids < "$work/container-ids"
if (( ${#container_ids[@]} )); then docker_root inspect "${container_ids[@]}" > "$work/containers.json"; else printf '[]\n' > "$work/containers.json"; fi
jq -e --arg root "$root" 'all(.[] | select(.Config.Labels["com.docker.compose.project"] == "junco-telemetry"); .Config.Labels["com.docker.compose.project.working_dir"] == $root)' "$work/containers.json" >/dev/null || fail 'An unrelated checkout owns project junco-telemetry.'
if (( ! managed_present )); then
  jq -e 'all(.[]; .Config.Labels["com.docker.compose.project"] != "junco-telemetry")' "$work/containers.json" >/dev/null || fail 'Project junco-telemetry exists without its managed service.'
fi
(( ${old_present[grafana-compose.service]} + ${old_present[grafana.service]} <= 1 )) || fail 'Ambiguous legacy Grafana service ownership.'
if (( ! reinstall )); then
  candidates=()
  for candidate in /opt/grafana/compose.yaml "$owner_home/.grafana/compose.yaml"; do
    [[ -f $candidate ]] || continue
    evidence=0
    for name in grafana-compose.service grafana.service; do
      [[ ${old_present[$name]} == 1 ]] || continue
      directory=$(systemctl show "$name" --property=WorkingDirectory --value)
      start=$(systemctl show "$name" --property=ExecStart --value)
      [[ $directory != "${candidate%/*}" && $start != *"$candidate"* ]] || evidence=1
    done
    if jq -e --arg candidate "$candidate" 'any(.[]; .Config.Labels["com.docker.compose.project"] == "grafana" and .Config.Labels["com.docker.compose.service"] == "grafana" and .Config.Labels["com.docker.compose.project.config_files"] == $candidate)' "$work/containers.json" >/dev/null; then evidence=1; fi
    (( ! evidence )) || candidates+=("$candidate")
  done
  (( ${#candidates[@]} == 1 )) || fail 'Cannot identify exactly one legacy Grafana Compose deployment.'
  legacy_grafana=${candidates[0]}
  jq -e --arg candidate "$legacy_grafana" 'all(.[] | select(.Config.Labels["com.docker.compose.project"] == "grafana"); .Config.Labels["com.docker.compose.service"] == "grafana" and .Config.Labels["com.docker.compose.project.config_files"] == $candidate)' "$work/containers.json" >/dev/null || fail 'Ambiguous legacy Grafana container ownership.'
  docker_root compose -p grafana -f "$legacy_grafana" config --format json > "$work/grafana-render.json"
  jq -e '[.services.grafana.volumes[] | select(.target == "/var/lib/grafana")] | length == 1' "$work/grafana-render.json" >/dev/null || fail 'Legacy Grafana store is ambiguous.'
  store_type=$(jq -r '.services.grafana.volumes[] | select(.target == "/var/lib/grafana") | .type' "$work/grafana-render.json")
  if [[ $store_type == bind ]]; then
    grafana_bind=$(jq -r '.services.grafana.volumes[] | select(.target == "/var/lib/grafana") | .source' "$work/grafana-render.json")
    [[ $grafana_bind != *$'\n'* && $grafana_bind != *$'\r'* && -d $grafana_bind && ! -L $grafana_bind ]] || fail 'Legacy Grafana bind source is missing or unsafe.'
    [[ $(realpath -e -- "$grafana_bind") == "$grafana_bind" ]] || fail 'Legacy Grafana bind source contains symlinks.'
    [[ $(stat -c '%u:%g:%a' -- "$grafana_bind") == 472:0:700 ]] || fail 'Legacy Grafana bind root must be 472:0 mode 0700.'
    jq -e --arg source "$grafana_bind" 'all(.[] | select(.Config.Labels["com.docker.compose.project"] == "grafana"); any(.Mounts[]; .Type == "bind" and .Source == $source and .Destination == "/var/lib/grafana"))' "$work/containers.json" >/dev/null || fail 'Legacy Grafana bind disagrees with its container.'
    adopt_bind=1
  elif [[ $store_type == volume ]]; then
    jq -e '. as $render | any(.services.grafana.volumes[]; .target == "/var/lib/grafana" and $render.volumes[.source].name == "grafana_data")' "$work/grafana-render.json" >/dev/null || fail 'Legacy Grafana does not own grafana_data.'
  else fail 'Unsupported legacy Grafana store.'; fi
else
  for name in "${legacy_units[@]}"; do [[ ${old_present[$name]} == 0 ]] || fail "Legacy unit remains during reinstall: $name"; done
fi
for volume in "${volumes[@]}"; do
  jq -e --arg volume "$volume" '[.volumes[] | select(.external == true and .name == $volume)] | length == 1' "$work/new-compose.json" >/dev/null || fail "Compose does not preserve external volume: $volume"
  if [[ $volume == grafana_data ]] && (( adopt_bind )); then
    if docker_root volume inspect "$volume" > "$work/$volume.json" 2>/dev/null; then fail 'grafana_data already exists; refusing to overwrite an unrelated/partial bind adoption.'; fi
    continue
  fi
  docker_root volume inspect "$volume" > "$work/$volume.json"
  jq -e --arg volume "$volume" 'length == 1 and .[0].Name == $volume and .[0].Driver == "local"' "$work/$volume.json" >/dev/null || fail "Wrong external volume: $volume"
  if [[ $volume == opik-opik_* ]]; then
    jq -e --arg logical "${volume#opik-opik_}" '.[0].Labels["com.docker.compose.project"] == "opik-opik" and .[0].Labels["com.docker.compose.volume"] == $logical' "$work/$volume.json" >/dev/null || fail "Unrelated owner of external volume: $volume"
  elif (( reinstall )); then
    jq -e 'any(.volumes[]; .external == true and .name == "grafana_data")' "$state_dir/compose.json" >/dev/null || fail 'Successful installer state does not own grafana_data.'
    if [[ -f $state_dir/grafana-volume.json ]]; then cmp -s "$state_dir/grafana-volume.json" "$work/$volume.json" || fail 'Installed Grafana volume identity changed.'; fi
    if jq -e --arg root "$root" '.[0].Labels["junco.telemetry.checkout"] == $root' "$work/$volume.json" >/dev/null; then
      [[ -f $state_dir/grafana-volume.json && -d $state_dir/baseline ]] || fail 'Adopted Grafana volume is missing its successful volume/Opik baseline state.'
    fi
  else
    jq -e '.[0].Labels["com.docker.compose.project"] == "grafana" and .[0].Labels["com.docker.compose.volume"] == "data"' "$work/$volume.json" >/dev/null || fail 'Unrelated owner of grafana_data.'
  fi
done
[[ $(jq '[.volumes[] | select(.external == true)] | length' "$work/new-compose.json") == 8 ]] || fail 'Compose declares unexpected external volumes.'
jq -e --arg root "$opik_root" 'all(.[] | select(.Config.Labels["com.docker.compose.project"] == "opik-opik"); .Config.Labels["com.docker.compose.project.working_dir"] == ($root + "/deployment/docker-compose"))' "$work/containers.json" >/dev/null || fail 'An unrelated checkout owns the legacy Opik project.'
if [[ ${old_present[opik.service]} == 1 ]]; then
  start=$(systemctl show opik.service --property=ExecStart --value)
  [[ $start == *"$opik_root/opik.sh"* ]] || fail 'Legacy opik.service does not own the inspected sibling deployment.'
fi
# Inactive legacy orphans are inventoried and removed, never added to rollback's running-services.
jq -e --argjson services "$(printf '%s\n' "${services[@]}" | jq -R . | jq -s .)" '
  all(.[] | select(.Config.Labels["com.docker.compose.project"] | IN("opik-opik", "junco-telemetry"));
    (.Config.Labels["com.docker.compose.service"] as $service | ($services | index($service)) != null)
    or (.Config.Labels["com.docker.compose.project"] == "opik-opik" and .State.Running == false))
' "$work/containers.json" >/dev/null || fail 'Unexpected active legacy or unknown managed service in a captured telemetry project.'
if [[ -n $grafana_bind ]]; then
  jq -e --arg source "$grafana_bind" 'all(.[]; . as $container | all(.Mounts[]?; . as $mount | if .Type == "bind" and (.Source == $source or (.Source | startswith($source + "/")) or ($source | startswith($mount.Source + "/"))) then $container.Config.Labels["com.docker.compose.project"] == "grafana" and $container.Config.Labels["com.docker.compose.service"] == "grafana" else true end))' "$work/containers.json" >/dev/null || fail 'An unrelated container mounts the legacy Grafana bind.'
fi
# Never stop a writer from an unrelated project or permit it to share legacy stores.
jq -e --argjson volumes "$(printf '%s\n' "${volumes[@]}" | jq -R . | jq -s .)" 'all(.[]; . as $container | all(.Mounts[]?; if .Type == "volume" and (.Name as $name | $volumes | index($name)) != null then ($container.Config.Labels["com.docker.compose.project"] as $project | ["grafana", "opik-opik", "junco-telemetry"] | index($project)) != null else true end))' "$work/containers.json" >/dev/null || fail 'An unrelated container mounts a preserved telemetry store.'
# Compose labels alone are insufficient: reserve each public port for its actual service.
jq -e 'all(.[] | select(.State.Running); . as $container | all(.NetworkSettings.Ports // {} | to_entries[] | .value[]?; if (.HostPort | IN("5173", "8000", "8001")) then ($container.Config.Labels as $l | ($l["com.docker.compose.project"] == "grafana" and $l["com.docker.compose.service"] == "grafana" and .HostPort == "8000") or ($l["com.docker.compose.project"] == "opik-opik" and ((.HostPort == "5173" and $l["com.docker.compose.service"] == "frontend") or (.HostPort == "8000" and $l["com.docker.compose.service"] == "python-backend"))) or ($l["com.docker.compose.project"] == "junco-telemetry" and ((.HostPort == "5173" and $l["com.docker.compose.service"] == "frontend") or (.HostPort == "8000" and $l["com.docker.compose.service"] == "grafana-proxy") or (.HostPort == "8001" and $l["com.docker.compose.service"] == "prometheus")))) else true end))' "$work/containers.json" >/dev/null || fail 'An unrelated container owns port 5173, 8000 or 8001.'
ss -H -ltnp '( sport = :5173 or sport = :8000 or sport = :8001 )' > "$work/listeners"
while read -r _ _ _ address _ processes; do
  [[ -n ${address:-} ]] || continue
  port=${address##*:}
  jq -e --arg port "$port" 'any(.[] | select(.State.Running) | .NetworkSettings.Ports // {} | .[][]?; .HostPort == $port)' "$work/containers.json" >/dev/null || fail "Unrelated host listener on port $port."
  # Docker Desktop forwarding may have no Linux PID; a visible non-Docker PID is a conflict.
  if [[ -n ${processes:-} && $processes != *'"docker-proxy"'* && $processes != *'"dockerd"'* && $processes != *'"com.docker.backend"'* ]]; then fail "Unrelated host listener on port $port: $processes"; fi
done < "$work/listeners"

sdk_config=''
if [[ -e $owner_home/.opik.config || -L $owner_home/.opik.config ]]; then
  IFS= read -r -d '' sdk_config < <(realpath -ze -- "$owner_home/.opik.config")
  [[ -f $sdk_config && $sdk_config != *$'\n'* && $sdk_config != *$'\r'* ]] || fail 'Unsupported .opik.config path.'
fi
if (( reinstall )) && [[ -d $state_dir/baseline ]]; then
  [[ -z $baseline_receipt ]] || fail 'Reinstall must use its recorded Opik baseline, not a replacement receipt.'
  baseline_receipt=$state_dir/baseline
fi
(( ! adopt_bind )) || [[ -n $baseline_receipt ]] || fail 'Bind adoption requires JUNCO_OPIK_BASELINE_RECEIPT with the preserved trace/eight spans.'
if [[ -n $baseline_receipt ]]; then
  [[ -d $baseline_receipt && ! -L $baseline_receipt ]] || fail 'Opik baseline receipt directory is missing or unsafe.'
  install -d -m 0700 "$work/baseline-expected" "$work/baseline-current"
  for kind in project traces spans; do
    [[ -f $baseline_receipt/baseline-$kind.json ]] || fail "Missing Opik baseline receipt: baseline-$kind.json"
    cp -- "$baseline_receipt/baseline-$kind.json" "$work/baseline-expected/"
  done
  normalize_baseline "$work/baseline-expected"
  capture_baseline "$work/baseline-current"
  normalize_baseline "$work/baseline-current"
  compare_baseline "$work/baseline-expected" "$work/baseline-current"
fi
# Pull while existing writers still run; no network/image resolution belongs in downtime.
compose pull --policy missing "${services[@]}"
if ! docker_root image inspect alpine:3.22 >/dev/null 2>&1; then docker_root pull alpine:3.22; fi

install -d -o root -g root -m 0700 /var/backups/junco-telemetry
backup=$(mktemp -d "/var/backups/junco-telemetry/$(date -u +%Y%m%dT%H%M%SZ).XXXXXXXX")
install -d -m 0700 "$backup/config" "$backup/volumes"
cp -a -- "$compose_file" "$root/telemetry" "$backup/config/"
cp -a -- "$opik_root/deployment/docker-compose" "$backup/config/opik-deployment"
[[ ! -e $root/.env ]] || cp -a -- "$root/.env" "$backup/config/junco.env"
[[ ! -e $opik_root/deployment/docker-compose/.env ]] || cp -a -- "$opik_root/deployment/docker-compose/.env" "$backup/config/opik.env"
for volume in "${volumes[@]}"; do [[ ! -s $work/$volume.json ]] || cp -- "$work/$volume.json" "$backup/volumes/"; done
[[ -z $baseline_receipt ]] || cp -a -- "$work/baseline-expected" "$backup/baseline"
mapfile -t image_names < <(jq -r '[.services[].image] | unique[]' "$work/new-compose.json")
docker_root image inspect "${image_names[@]}" > "$backup/selected-images.json"
mapfile -t legacy_images < <(jq -r '[.[] | select(.Config.Labels["com.docker.compose.project"] | IN("grafana", "opik-opik", "junco-telemetry")) | .Image] | unique[]' "$work/containers.json")
if (( ${#legacy_images[@]} )); then docker_root image inspect "${legacy_images[@]}" > "$backup/previous-images.json"; fi
cp -- "$work/new-compose.json" "$backup/new-compose.json"
for image in "${image_names[@]}"; do
  image_id=$(docker_root image inspect --format '{{.Id}}' "$image")
  jq --arg image "$image" --arg id "$image_id" '.services |= with_entries(if .value.image == $image then .value.image = $id else . end)' "$backup/new-compose.json" > "$work/pinned-compose.json"
  mv -fT -- "$work/pinned-compose.json" "$backup/new-compose.json"
done
if (( ! reinstall )); then
  archive_kib=0
  copy_kib=0
  for volume in "${volumes[@]}"; do
    source_mount="type=volume,source=$volume,target=/source,readonly"
    if [[ $volume == grafana_data ]] && (( adopt_bind )); then source_mount="type=bind,source=$grafana_bind,target=/source,readonly"; fi
    size=$(docker_root run --rm --pull never --network none --mount "$source_mount" alpine:3.22 du -sb /source)
    read -r size _ <<< "$size"
    [[ $size =~ ^[0-9]+$ ]] || fail "Cannot measure preserved store: $volume"
    size=$(((size + 1023) / 1024))
    archive_kib=$((archive_kib + size))
    if [[ $volume == grafana_data ]] && (( adopt_bind )); then copy_kib=$size; fi
    printf '%s\t%s\n' "$volume" "$size" >> "$backup/store-sizes-kib.tsv"
  done
  read -r available_kib < <(df -k --output=avail "$backup" | { read -r _; read -r available; printf '%s\n' "$available"; })
  required_kib=$((archive_kib + archive_kib / 10 + copy_kib + 65536))
  (( available_kib >= required_kib )) || fail "Insufficient backup disk space: need $required_kib KiB, available $available_kib KiB."
  if (( adopt_bind )); then
    docker_space=$(docker_root run --rm --pull never --network none --mount type=volume,source=opik-opik_minio-data,target=/source,readonly alpine:3.22 df -Pk /source)
    read -r _ available_kib _ < <(printf '%s\n' "$docker_space" | { read -r _; read -r source blocks used available rest; printf '%s %s %s\n' "$source" "$available" "$rest"; })
    (( available_kib >= copy_kib + 65536 )) || fail 'Insufficient Docker volume disk space for Grafana adoption.'
  fi
fi
for name in "${legacy_units[@]}" "$managed_unit"; do
  [[ ${old_present[$name]} != 1 ]] || cp --preserve=all -- "$unit_dir/$name" "$backup/$name"
  printf '%s\t%s\t%s\n' "$name" "${old_enabled[$name]}" "${old_active[$name]}" >> "$backup/unit-state.tsv"
  systemctl show "$name" > "$backup/$name.properties"
done
[[ -z $sdk_config ]] || cp --preserve=all -- "$sdk_config" "$backup/opik.config"
cp --preserve=all -- "$work/containers.json" "$backup/containers.json"
if (( reinstall )); then cp --preserve=all -- "$state_dir/compose.json" "$backup/old-managed-compose.json"; fi
for project in grafana opik-opik; do
  jq -r --arg project "$project" '[.[] | select(.State.Running and .Config.Labels["com.docker.compose.project"] == $project) | .Config.Labels["com.docker.compose.service"]] | unique[]' "$work/containers.json" > "$backup/$project.running-services"
  [[ ! -s $backup/$project.running-services ]] || printf '%s\n' "$project" >> "$backup/running-projects"
done
if [[ -f $legacy_grafana ]]; then
  cp --preserve=all -- "$legacy_grafana" "$backup/grafana-compose.yaml"
fi
old_nginx_port=$(jq -r '[.[] | select(.State.Running and .Config.Labels["com.docker.compose.project"] == "opik-opik" and .Config.Labels["com.docker.compose.service"] == "frontend") | .Config.Env[]? | select(startswith("NGINX_PORT=")) | ltrimstr("NGINX_PORT=")] | unique | if length > 1 then error("multiple old frontend ports") else .[0] // "5173" end' "$work/containers.json")
[[ $old_nginx_port =~ ^[0-9]+$ ]] || fail 'Invalid previous Opik frontend port.'
docker_owner compose -p opik-opik -f "$upstream" --profile opik config --format json > "$work/opik-render.json"
# Restore exact running images, environment and all published ports (including ephemeral ports).
for project in grafana opik-opik; do
  render=$work/grafana-render.json
  [[ $project != opik-opik ]] || render=$work/opik-render.json
  [[ -f $render ]] || continue
  jq --slurpfile containers "$work/containers.json" --arg project "$project" --arg nginx "$old_nginx_port" '
    if $project == "opik-opik" then
      .services.frontend.environment.NGINX_PORT = $nginx |
      .services.frontend.healthcheck.test = ["CMD", "curl", "--fail", ("http://localhost:" + $nginx + "/health")]
    else . end |
    reduce ($containers[0][] | select(.State.Running and .Config.Labels["com.docker.compose.project"] == $project)) as $container (.;
      ($container.Config.Labels["com.docker.compose.service"]) as $service |
      if .services[$service] == null then error("running legacy service absent from saved compose: " + $service) else
        .services[$service].image = $container.Image |
        .services[$service].environment = (reduce ($container.Config.Env[]? | index("=") as $i | select($i != null) | {key: .[:$i], value: (.[$i+1:] | gsub("\\$"; "$$"))}) as $env ({}; .[$env.key] = $env.value)) |
        .services[$service].ports = [($container.NetworkSettings.Ports // {} | to_entries[]) as $binding | $binding.value[]? | {target: ($binding.key | split("/")[0] | tonumber), protocol: ($binding.key | split("/")[1]), published: .HostPort, host_ip: .HostIp}] |
        del(.services[$service].build)
      end)
  ' "$render" > "$backup/$project-compose.json"
  docker_root compose -p "$project" -f "$backup/$project-compose.json" config -q
done
jq '[.[] | select(.Config.Labels["com.docker.compose.project"] == "opik-opik" and .Config.Labels["com.docker.compose.service"] == "frontend") | {name: .Name, ports: .NetworkSettings.Ports, environment: .Config.Env}]' "$work/containers.json" > "$backup/old-opik-frontend.json"

# Anonymous inspection must succeed before the first cutover; unknown state is not permission to overwrite it.
curl -q --noproxy '*' --fail --silent --show-error --max-time 15 http://localhost:8000/api/datasources > "$backup/grafana-datasources.json" || fail 'Existing Grafana datasource state is unavailable; no workloads were stopped.'
jq -e 'type == "array" and all(.[]; if .uid == "junco-prometheus" or .name == "Junco Prometheus" then .uid == "junco-prometheus" and .name == "Junco Prometheus" and .type == "prometheus" and .url == "http://prometheus:9090" else true end)' "$backup/grafana-datasources.json" >/dev/null || fail 'Preexisting Grafana datasource conflicts with junco-prometheus/Junco Prometheus.'
curl -q --noproxy '*' --fail --silent --show-error --max-time 15 'http://localhost:8000/api/search?type=dash-db' > "$backup/grafana-dashboards.json"
while IFS= read -r dashboard_uid; do
  [[ $dashboard_uid =~ ^[a-zA-Z0-9_-]+$ ]] || fail 'Unsupported Grafana dashboard UID.'
  curl -q --noproxy '*' --fail --silent --show-error --max-time 15 "http://localhost:8000/api/dashboards/uid/$dashboard_uid" > "$backup/dashboard-$dashboard_uid.json"
done < <(jq -r '.[].uid' "$backup/grafana-dashboards.json")

# Validate a candidate before downtime and before replacing a previously managed unit.
unit_tmp=$(mktemp "$unit_dir/.junco-telemetry.XXXXXXXX.service")
docker_wants=''
[[ $(systemctl show docker.service --property=LoadState --value) == not-found ]] || docker_wants=' docker.service'
{
  printf '%s\n[Unit]\nDescription=Junco telemetry (Grafana, Prometheus, Opik)\n' "$marker"
  printf 'Wants=network-online.target%s\nAfter=network-online.target docker.service\nStartLimitIntervalSec=0\n\n' "$docker_wants"
  printf '[Service]\nType=oneshot\nRemainAfterExit=yes\nUser='
  unit_quote "$owner"
  printf '\nWorkingDirectory='
  unit_quote "$root"
  printf '\nEnvironment='
  unit_quote "HOME=$owner_home" exec
  printf '\nEnvironment=DOCKER_HOST=unix:///var/run/docker.sock\nExecStartPre='
  unit_quote "$docker" exec
  printf ' info\nExecStart='
  unit_quote "$docker" exec
  printf ' compose -f '
  unit_quote "$compose_file" exec
  printf ' up -d --no-build --pull never --wait --wait-timeout 600\nExecStop='
  unit_quote "$docker" exec
  printf ' compose -f '
  unit_quote "$compose_file" exec
  printf ' stop --timeout 120\nRestart=on-failure\nRestartSec=15s\nTimeoutStartSec=660\nTimeoutStopSec=180\n\n[Install]\nWantedBy=multi-user.target\n'
} > "$unit_tmp"
chown root:root "$unit_tmp"
chmod 0644 "$unit_tmp"
systemd-analyze verify "$unit_tmp"
compose config --format json > "$work/final-compose.json"
cmp -s -- "$work/new-compose.json" "$work/final-compose.json" || fail 'Compose configuration changed during preflight.'

cutover=1
for name in "${legacy_units[@]}"; do
  [[ ${old_present[$name]} == 1 ]] || continue
  systemctl disable "$name"
  systemctl stop "$name"
done
if (( managed_present )); then systemctl stop "$managed_unit"; fi
if (( ! reinstall )); then
  if [[ -f $backup/grafana-compose.json ]]; then docker_root compose -p grafana -f "$backup/grafana-compose.json" down --remove-orphans; fi
  if [[ -f $backup/opik-opik-compose.json ]]; then docker_root compose -p opik-opik -f "$backup/opik-opik-compose.json" down --remove-orphans; fi
fi
# Reject any remaining writer, including a detached container not covered by a legacy service.
for volume in "${volumes[@]}"; do
  remaining=$(docker_root ps -q --filter "volume=$volume")
  [[ -z $remaining ]] || fail "A writer still uses $volume: $remaining"
done
if [[ -n $grafana_bind ]]; then
  mapfile -t remaining_ids < <(docker_root ps -q)
  if (( ${#remaining_ids[@]} )); then
    docker_root inspect "${remaining_ids[@]}" > "$work/remaining-containers.json"
    jq -e --arg source "$grafana_bind" 'all(.[] | .Mounts[]?; . as $mount | .Type != "bind" or (.Source != $source and (.Source | startswith($source + "/") | not) and ($source | startswith($mount.Source + "/") | not)))' "$work/remaining-containers.json" >/dev/null || fail 'A writer still mounts the legacy Grafana bind.'
  fi
fi
if (( ! reinstall )); then
  for volume in "${volumes[@]}"; do
    source_mount="type=volume,source=$volume,target=/source,readonly"
    if [[ $volume == grafana_data ]] && (( adopt_bind )); then source_mount="type=bind,source=$grafana_bind,target=/source,readonly"; fi
    docker_root run --rm --pull never --network none --mount "$source_mount" --mount "type=bind,source=$backup,target=/backup" alpine:3.22 tar -czf "/backup/$volume.tar.gz" -C /source .
    tar -tzf "$backup/$volume.tar.gz" >/dev/null
  done
fi
if (( adopt_bind )); then
  printf '%s\n' "$grafana_bind" > "$backup/grafana-bind-source"
  if docker_root volume inspect grafana_data >/dev/null 2>&1; then fail 'grafana_data appeared during cutover; refusing to overwrite it.'; fi
  docker_root volume create --label junco.telemetry.checkout="$root" grafana_data > "$backup/grafana-created-volume.txt"
  docker_root run --rm --pull never --network none --mount "type=bind,source=$grafana_bind,target=/source,readonly" --mount type=volume,source=grafana_data,target=/target alpine:3.22 sh -ec '
    test -z "$(ls -A /target)"
    cp -a /source/. /target/
    test "$(stat -c "%u:%g:%a" /target)" = "472:0:700"
    diff -r /source /target
    cd /source
    find . -exec sh -ec '\''for path do
      test "$(stat -c "%u:%g:%a:%F" "/source/$path")" = "$(stat -c "%u:%g:%a:%F" "/target/$path")"
      if test -L "/source/$path"; then test "$(readlink "/source/$path")" = "$(readlink "/target/$path")"; fi
    done'\'' sh {} +
  '
  printf '%s\n' 'Grafana copy contents, UID:GID and modes verified; original bind retained.' > "$backup/grafana-copy-verified"
fi
mv -fT -- "$unit_tmp" "$unit_dir/$managed_unit"
unit_tmp=''
systemctl daemon-reload
systemctl enable "$managed_unit"
systemctl restart "$managed_unit"

curl -q --noproxy '*' --fail --silent --show-error --max-time 15 http://localhost:8000/api/health > "$backup/grafana-health.json"
jq -e '.database == "ok"' "$backup/grafana-health.json" >/dev/null
curl -q --noproxy '*' --fail --silent --show-error --max-time 15 http://localhost:8001/-/ready > "$backup/prometheus-ready.txt"
curl -q --noproxy '*' --fail --silent --show-error --max-time 15 http://localhost:5173/health > "$backup/opik-health.txt"
curl -q --noproxy '*' --fail --silent --show-error --max-time 15 http://localhost:5173/api/health-check > "$backup/opik-api-health.txt"
curl -q --noproxy '*' --fail --silent --show-error --max-time 15 --get http://localhost:8000/api/datasources/proxy/uid/junco-prometheus/api/v1/query --data-urlencode 'query=vector(1)' > "$backup/prometheus-query.json"
jq -e '.status == "success" and .data.resultType == "vector" and (.data.result | length == 1) and (.data.result[0].value[1] | tonumber) == 1' "$backup/prometheus-query.json" >/dev/null
if [[ -n $baseline_receipt ]]; then
  install -d -m 0700 "$backup/baseline-after"
  capture_baseline "$backup/baseline-after"
  normalize_baseline "$backup/baseline-after"
  compare_baseline "$backup/baseline" "$backup/baseline-after"
fi

if [[ -n $sdk_config ]]; then
  cmp -s -- "$backup/opik.config" "$sdk_config" || fail '.opik.config changed during installation; refusing to overwrite it.'
  config_tmp=$(mktemp "${sdk_config%/*}/.opik.config.junco.XXXXXXXX")
  cp --preserve=all -- "$sdk_config" "$config_tmp"
  in_opik=0
  changed=0
  url_pattern='^([[:blank:]]*url_override[[:blank:]]*=[[:blank:]]*)http://localhost:8888/api/?([[:blank:]]*([#;].*)?)$'
  section_pattern='^[[:blank:]]*\[([^]]+)\][[:blank:]]*([#;].*)?$'
  {
    while true; do
      terminated=1
      IFS= read -r line || terminated=0
      [[ -n $line || $terminated == 1 ]] || break
      if [[ $line =~ $section_pattern ]]; then
        in_opik=0
        [[ ${BASH_REMATCH[1]} != opik ]] || in_opik=1
      elif (( in_opik )) && [[ $line =~ $url_pattern ]]; then
        line=${BASH_REMATCH[1]}http://localhost:5173/api/${BASH_REMATCH[2]}
        changed=1
      fi
      printf '%s' "$line"
      (( ! terminated )) || printf '\n'
      (( terminated )) || break
    done < "$sdk_config"
  } > "$config_tmp"
  if (( changed )); then
    sdk_changed=1
    mv -fT -- "$config_tmp" "$sdk_config"
  else
    rm -f -- "$config_tmp"
  fi
  config_tmp=''
fi
for name in "${legacy_units[@]}"; do
  [[ ${old_present[$name]} != 1 ]] || rm -f -- "$unit_dir/$name"
done
systemctl daemon-reload
for name in "${legacy_units[@]}"; do systemctl reset-failed "$name" 2>/dev/null || true; done
install -d -o root -g root -m 0700 "$state_dir"
docker_root volume inspect grafana_data > "$work/grafana-volume.json"
atomic_copy "$work/grafana-volume.json" "$state_dir/grafana-volume.json"
if [[ -n $baseline_receipt ]]; then
  [[ -d $state_dir/baseline ]] || cp -a -- "$backup/baseline" "$state_dir/baseline"
fi
state_changed=1
state_tmp=$(mktemp "$state_dir/.compose.XXXXXXXX")
cp --preserve=all -- "$backup/new-compose.json" "$state_tmp"
mv -fT -- "$state_tmp" "$state_dir/compose.json"
state_tmp=$(mktemp "$state_dir/.installed.XXXXXXXX")
printf '%s\n' "$root" > "$state_tmp"
mv -fT -- "$state_tmp" "$state_dir/installed"
printf 'Installation completed at %s\n' "$(date -u +%FT%TZ)" > "$backup/success"
complete=1
printf 'Backups: %s\nGrafana: http://localhost:8000/\nPrometheus: http://localhost:8001/\nOpik: http://localhost:5173/\n' "$backup"
