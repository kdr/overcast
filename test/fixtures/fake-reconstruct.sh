#!/usr/bin/env bash
# Offline fixture: a bound reconstruct provider emitting the multi-output
# envelope (payload.outputs[] = synthesized views / mesh / depth) so the real
# fanOutReconstruct + sweep post-processing + viewer paths are exercised without
# fal. "Synthesized" views are copies of the input (real image bytes when the
# test feeds a real png, so the ffmpeg sheet/turntable assembly runs for real).
# Deliberately emits NO payload.caveat — the verb must stamp it regardless.
set -uo pipefail
op="${1:-run}"
case "$op" in
  init) exit 0 ;;
  describe) echo '{"verb":"reconstruct","kind":"media.reconstruction","ops":["view","sweep","model","depth","age"]}'; exit 0 ;;
esac
input=""; ops="view"; rotate=""; count=""; age_years=""
while [ "$#" -gt 0 ]; do case "$1" in
  --input)     input="${2:-}"; shift 2 2>/dev/null || shift ;;
  --ops)       ops="${2:-}"; shift 2 2>/dev/null || shift ;;
  --rotate)    rotate="${2:-}"; shift 2 2>/dev/null || shift ;;
  --count)     count="${2:-}"; shift 2 2>/dev/null || shift ;;
  --age-years) age_years="${2:-}"; shift 2 2>/dev/null || shift ;;
  # --elevate/--zoom/--prompt/--seed accepted-and-ignored via the catch-all
  --elevate|--zoom|--prompt|--seed) shift 2 2>/dev/null || shift ;;
  --*) shift ;;
  *) input="$1"; shift ;;
esac; done
OUT="${OVERCAST_MEDIA_DIR:-.}/reconstruct"
mkdir -p "$OUT"
base="$(basename "${input%.*}")"

emit() { # $1 op, $2 outputs json, $3 extra payload json
  jq -nc --arg inp "$input" --arg o "$1" --argjson outs "$2" --argjson extra "$3" \
    '{verb:"reconstruct",format:"json",payload:({op:$o,input:$inp,model:"fake",count:($outs|length),outputs:$outs} + $extra),media:{ref:$inp},meta:{provider:"fake:reconstruct"},state:"ready"}'
}

case "$ops" in
  view)
    v="$OUT/${base}_az${rotate:-0}.png"; cp "$input" "$v"
    emit view "$(jq -nc --arg r "$v" --arg az "${rotate:-0}" '[{kind:"view",ref:$r,azimuth:($az|tonumber),seed:7}]')" \
      "$(jq -nc --arg az "${rotate:-0}" '{rotate:($az|tonumber)}')"
    ;;
  sweep)
    n="${count:-4}"; i=0; outs="[]"
    while [ "$i" -lt "$n" ]; do
      az=$((i * 360 / n))
      v="$OUT/${base}_az${az}.png"; cp "$input" "$v"
      outs="$(jq -c --arg r "$v" --arg az "$az" '. + [{kind:"view",ref:$r,azimuth:($az|tonumber)}]' <<<"$outs")"
      i=$((i + 1))
    done
    emit sweep "$outs" '{}'
    ;;
  model)
    m="$OUT/${base}_mesh.glb"; printf 'glTF-fixture-bytes' > "$m"
    emit model "$(jq -nc --arg r "$m" '[{kind:"mesh",ref:$r,format:"glb"}]')" '{}'
    ;;
  depth)
    d="$OUT/${base}_depth.png"; cp "$input" "$d"
    emit depth "$(jq -nc --arg r "$d" '[{kind:"depth",ref:$r}]')" '{}'
    ;;
  age)
    # like the others: NO caveat emitted — the verb must stamp the EXTENDED
    # age caveat (synthesized likeness / never a match probe) regardless.
    a="$OUT/${base}_age${age_years:-0}.png"; cp "$input" "$a"
    emit age "$(jq -nc --arg r "$a" --arg y "${age_years:-0}" '[{kind:"age",ref:$r,age_years:($y|tonumber),seed:7}]')" \
      "$(jq -nc --arg y "${age_years:-0}" '{age_years:($y|tonumber)}')"
    ;;
  *)
    jq -nc --arg e "unknown ops $ops" '{verb:"reconstruct",format:"json",payload:{},error:$e,state:"error"}'
    ;;
esac
