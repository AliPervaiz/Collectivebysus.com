#!/usr/bin/env bash
# Local end-to-end smoke test for the CRM + galleries. LOCAL ONLY.
#
# Prereqs: .dev.vars with DEV_ADMIN_BYPASS=true, SESSION_SECRET and
# CAL_WEBHOOK_SECRET=local-test-secret; migrations applied; `npm run dev` running.
# Usage: scripts/smoke-test.sh [base_url]   (default http://localhost:8791)
#
# Creates throwaway rows (emails *@smoke.example) and deletes them at the end.
set -u
B="${1:-http://localhost:8791}"
case "$B" in http://localhost*|http://127.0.0.1*) ;; *) echo "Refusing: local URLs only"; exit 2;; esac
CAL_SECRET="${CAL_SECRET:-local-test-secret}"
DB="${DB:-fieldnote-crm}"
PASS=0; FAIL=0
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
J=(-H "x-requested-with: fetch" -H "content-type: application/json")

ok()   { PASS=$((PASS+1)); printf '  ok    %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  FAIL  %s  (%s)\n' "$1" "$2"; }
# expect <name> <status> <curl args...>  -> body in $TMP/body
expect() {
  local name="$1" want="$2"; shift 2
  local got; got=$(curl -s -o "$TMP/body" -w '%{http_code}' "$@")
  if [ "$got" = "$want" ]; then ok "$name"; else bad "$name" "want $want got $got: $(head -c 200 "$TMP/body")"; fi
}
has()  { if grep -q -- "$2" "$TMP/body"; then ok "$1"; else bad "$1" "missing '$2': $(head -c 200 "$TMP/body")"; fi; }
jget() { node -e 'let s=require("fs").readFileSync(0,"utf8");let o=JSON.parse(s);for(const k of process.argv[1].split("."))o=o==null?o:o[k];process.stdout.write(o==null?"":String(o))' "$1" < "$TMP/body"; }
sql()  { npx wrangler d1 execute "$DB" --local --command "$1" >/dev/null 2>&1; }

echo "== auth + CSRF"
expect "admin API 403 on non-localhost host" 403 -H "Host: fieldnote.example" "$B/api/admin/dashboard"
expect "admin page 403 on non-localhost host" 403 -H "Host: fieldnote.example" "$B/admin/"
expect "admin API 403 with a forged Access JWT" 403 -H "Host: fieldnote.example" -H "cf-access-jwt-assertion: aaa.bbb.ccc" "$B/api/admin/clients"
expect "mutation without x-requested-with -> 400" 400 -X POST -H "content-type: application/json" -d '{"name":"x"}' "$B/api/admin/clients"
expect "dashboard on localhost" 200 "$B/api/admin/dashboard"
has  "dashboard has attention list" '"attention"'
expect "admin page noindex header" 200 -D "$TMP/h" "$B/admin/"
grep -qi "x-robots-tag: noindex" "$TMP/h" && ok "admin x-robots-tag" || bad "admin x-robots-tag" "header missing"

echo "== public inquiry"
sql "DELETE FROM rate_limits"
expect "public settings" 200 "$B/api/public/settings"
TOKEN=$(jget form_token)
[ -n "$TOKEN" ] && ok "form token issued" || bad "form token issued" "empty"
expect "inquiry without fetch header -> 400" 400 -X POST -H "content-type: application/json" -d '{}' "$B/api/inquiry"
expect "inquiry too fast -> 400" 400 "${J[@]}" -X POST "$B/api/inquiry" \
  -d "{\"form_token\":\"$TOKEN\",\"name\":\"Speedy\",\"email\":\"speedy@smoke.example\",\"session_type\":\"portrait\"}"
has "timing message" "wait a moment"
expect "inquiry forged token -> 400" 400 "${J[@]}" -X POST "$B/api/inquiry" \
  -d '{"form_token":"1700000000000.deadbeef","name":"F","email":"f@smoke.example","session_type":"portrait"}'
sleep 3.2
expect "inquiry honeypot pretends success" 200 "${J[@]}" -X POST "$B/api/inquiry" \
  -d "{\"form_token\":\"$TOKEN\",\"website\":\"http://spam\",\"name\":\"Bot\",\"email\":\"bot@smoke.example\",\"session_type\":\"portrait\"}"
expect "inquiry bad email -> 400" 400 "${J[@]}" -X POST "$B/api/inquiry" \
  -d "{\"form_token\":\"$TOKEN\",\"name\":\"A\",\"email\":\"nope\",\"session_type\":\"portrait\"}"
expect "inquiry bad session type -> 400" 400 "${J[@]}" -X POST "$B/api/inquiry" \
  -d "{\"form_token\":\"$TOKEN\",\"name\":\"A\",\"email\":\"a@smoke.example\",\"session_type\":\"wedding\"}"
curl -s "$B/api/public/availability" > "$TMP/avail"
OD=$(node -e 'const d=JSON.parse(require("fs").readFileSync(0));process.stdout.write(JSON.stringify((d.open_days||[]).slice(0,2)))' < "$TMP/avail")
expect "inquiry valid -> 201" 201 "${J[@]}" -X POST "$B/api/inquiry" \
  -d "{\"form_token\":\"$TOKEN\",\"name\":\"Smoke Tester\",\"email\":\"smoke@smoke.example\",\"phone\":\"512-555-0100\",\"instagram\":\"@smoke.tester\",\"session_type\":\"graduation\",\"preferred_dates\":$OD,\"date_notes\":\"Golden hour\",\"location\":\"Campus\",\"people_count\":\"1\",\"usage\":\"Announcements\",\"referral\":\"instagram\",\"message\":\"<script>alert(1)</script>\"}"
has "thank-you includes price note" '"price_note"'
expect "honeypot stored nothing" 200 "$B/api/admin/clients?q=bot%40smoke"
grep -q 'bot@smoke.example' "$TMP/body" && bad "honeypot stored nothing" "bot client exists" || ok "no bot client"
expect "inquiry created client" 200 "$B/api/admin/clients?q=smoke%40smoke"
has "client found" 'smoke@smoke.example'
# Rate limit: 5 per hour per IP. Valid + bad ones above count only if they passed the token step.
for i in 1 2 3 4 5 6; do
  code=$(curl -s -o "$TMP/body" -w '%{http_code}' "${J[@]}" -X POST "$B/api/inquiry" \
    -d "{\"form_token\":\"$TOKEN\",\"name\":\"Rate $i\",\"email\":\"rate$i@smoke.example\",\"session_type\":\"event\"}")
  [ "$code" = 429 ] && break
done
[ "$code" = 429 ] && ok "rate limit returns 429 (after $i more)" || bad "rate limit" "never got 429"
sql "DELETE FROM rate_limits"

echo "== clients, sessions, payments"
expect "create client missing name -> 400" 400 "${J[@]}" -X POST "$B/api/admin/clients" -d '{"email":"x@smoke.example"}'
expect "create client" 201 "${J[@]}" -X POST "$B/api/admin/clients" \
  -d '{"name":"Smoke Minor","email":"minor@smoke.example","is_minor":true,"guardian_name":"Pat Guardian","can_post":"no"}'
CID=$(jget client.id)
expect "duplicate email -> 409" 409 "${J[@]}" -X POST "$B/api/admin/clients" -d '{"name":"Dup","email":"minor@smoke.example"}'
expect "bad can_post -> 400" 400 "${J[@]}" -X PATCH "$B/api/admin/clients/$CID" -d '{"can_post":"maybe"}'
expect "update client" 200 "${J[@]}" -X PATCH "$B/api/admin/clients/$CID" -d '{"can_post":"ask","phone":"512-555-0101"}'
expect "log contact" 201 "${J[@]}" -X POST "$B/api/admin/clients/$CID/activity" -d '{"kind":"contact","channel":"instagram","body":"Replied in DMs"}'
expect "client detail" 200 "$B/api/admin/clients/$CID"
has "client detail has activity" '"activity"'
expect "create session bad status -> 400" 400 "${J[@]}" -X POST "$B/api/admin/sessions" -d "{\"client_id\":\"$CID\",\"type\":\"graduation\",\"status\":\"partying\"}"
expect "create session" 201 "${J[@]}" -X POST "$B/api/admin/sessions" \
  -d "{\"client_id\":\"$CID\",\"type\":\"graduation\",\"status\":\"booked\",\"quoted_cents\":30000,\"starts_at\":\"2026-12-20T15:00\",\"hours\":1.5,\"location\":\"Campus\"}"
SID=$(jget session.id)
expect "negative payment -> 400" 400 "${J[@]}" -X POST "$B/api/admin/sessions/$SID/payments" -d '{"amount_cents":-5,"method":"venmo","kind":"retainer","paid_on":"2026-11-01"}'
expect "bad method -> 400" 400 "${J[@]}" -X POST "$B/api/admin/sessions/$SID/payments" -d '{"amount_cents":500,"method":"bitcoin","kind":"retainer","paid_on":"2026-11-01"}'
expect "record retainer" 201 "${J[@]}" -X POST "$B/api/admin/sessions/$SID/payments" -d '{"amount_cents":10000,"method":"venmo","kind":"retainer","paid_on":"2026-11-01"}'
PID=$(jget payment.id)
expect "session detail" 200 "$B/api/admin/sessions/$SID"
has "balance owed computed (200.00 left)" '"balance_cents":20000'
expect "stage change to shot" 200 "${J[@]}" -X PATCH "$B/api/admin/sessions/$SID" -d '{"status":"shot"}'
expect "sessions filter by stage" 200 "$B/api/admin/sessions?status=shot"
has "filtered list has session" "$SID"
expect "delete payment" 200 "${J[@]}" -X DELETE "$B/api/admin/payments/$PID"

echo "== availability (day picker)"
jsn() { node -e "$1" "${@:2}"; }
expect "public availability" 200 "$B/api/public/availability"
has "open days listed" '"open_days"'
cp "$TMP/body" "$TMP/avail"
D1=$(jsn 'const d=JSON.parse(require("fs").readFileSync(process.argv[1]));process.stdout.write(d.open_days[0]||"")' "$TMP/avail")
D2=$(jsn 'const d=JSON.parse(require("fs").readFileSync(process.argv[1]));process.stdout.write(d.open_days[1]||"")' "$TMP/avail")
[ -n "$D1" ] && [ -n "$D2" ] && ok "has open days ($D1, $D2)" || bad "has open days" "none"
WEEKDAYS=$(jsn 'const d=JSON.parse(require("fs").readFileSync(process.argv[1]));process.stdout.write(String(d.open_days.filter(x=>![0,6].includes(new Date(x+"T12:00:00Z").getUTCDay())).length))' "$TMP/avail")
[ "$WEEKDAYS" = 0 ] && ok "only weekends are open by default" || bad "only weekends open" "$WEEKDAYS weekday(s) open"
in_open() { curl -s "$B/api/public/availability" | grep -q "\"$1\""; }
SIDS=""
for i in 1 2 3; do
  expect "book shoot $i on $D1" 201 "${J[@]}" -X POST "$B/api/admin/sessions" \
    -d "{\"client_id\":\"$CID\",\"type\":\"portrait\",\"status\":\"booked\",\"starts_at\":\"${D1}T16:00:00.000Z\"}"
  SIDS="$SIDS $(jget session.id)"
done
in_open "$D1" && bad "3 shoots fill the day" "$D1 still open" || ok "3 shoots fill the day"
expect "admin availability" 200 "$B/api/admin/availability?from=$D1&to=$D1"
has "admin sees full" '"reason":"full"'
expect "inquiry picking a full day -> 409" 409 "${J[@]}" -X POST "$B/api/inquiry" \
  -d "{\"form_token\":\"$TOKEN\",\"name\":\"Full Day\",\"email\":\"full@smoke.example\",\"session_type\":\"portrait\",\"preferred_dates\":[\"$D1\"]}"
has "409 lists the unavailable day" "$D1"
FIRST_SID=$(echo $SIDS | cut -d' ' -f1)
expect "mark one shoot lost" 200 "${J[@]}" -X PATCH "$B/api/admin/sessions/$FIRST_SID" -d '{"status":"lost"}'
in_open "$D1" && ok "lost sessions don't count" || bad "lost sessions don't count" "$D1 still full"
expect "block $D2" 200 "${J[@]}" -X PUT "$B/api/admin/days/$D2" -d '{"kind":"blocked","note":"family"}'
in_open "$D2" && bad "blocked day hidden" "$D2 still open" || ok "blocked day hidden"
expect "unblock $D2" 200 "${J[@]}" -X DELETE "$B/api/admin/days/$D2"
in_open "$D2" && ok "unblocked day back" || bad "unblocked day back" "$D2 missing"
WED=$(jsn 'let d=new Date(process.argv[1]+"T12:00:00Z");do{d.setUTCDate(d.getUTCDate()+1)}while(d.getUTCDay()!==3);process.stdout.write(d.toISOString().slice(0,10))' "$D1")
in_open "$WED" && bad "weekday closed by default" "$WED open" || ok "weekday closed by default"
expect "weekday inquiry -> 409" 409 "${J[@]}" -X POST "$B/api/inquiry" \
  -d "{\"form_token\":\"$TOKEN\",\"name\":\"Weekday\",\"email\":\"wd@smoke.example\",\"session_type\":\"portrait\",\"preferred_dates\":[\"$WED\"]}"
expect "open $WED" 200 "${J[@]}" -X PUT "$B/api/admin/days/$WED" -d '{"kind":"open"}'
in_open "$WED" && ok "opened weekday appears" || bad "opened weekday appears" "$WED missing"
expect "remove opening" 200 "${J[@]}" -X DELETE "$B/api/admin/days/$WED"
expect "bad day -> 400" 400 "${J[@]}" -X PUT "$B/api/admin/days/not-a-day" -d '{"kind":"blocked"}'
expect "bad kind -> 400" 400 "${J[@]}" -X PUT "$B/api/admin/days/$D2" -d '{"kind":"maybe"}'
expect "day overrides need auth" 403 -H "Host: fieldnote.example" "${J[@]}" -X PUT "$B/api/admin/days/$D2" -d '{"kind":"blocked"}'
expect "garbage date in inquiry -> 400" 400 "${J[@]}" -X POST "$B/api/inquiry" \
  -d "{\"form_token\":\"$TOKEN\",\"name\":\"G\",\"email\":\"g@smoke.example\",\"session_type\":\"portrait\",\"preferred_dates\":[\"next sat\"]}"
SIX=$(jsn 'const d=JSON.parse(require("fs").readFileSync(process.argv[1]));process.stdout.write(JSON.stringify(d.open_days.slice(1,7)))' "$TMP/avail")
expect "too many days -> 400" 400 "${J[@]}" -X POST "$B/api/inquiry" \
  -d "{\"form_token\":\"$TOKEN\",\"name\":\"Six\",\"email\":\"six@smoke.example\",\"session_type\":\"portrait\",\"preferred_dates\":$SIX}"
expect "settings: 0 shoots/day -> 400" 400 "${J[@]}" -X PUT "$B/api/admin/settings" -d '{"settings":{"max_shoots_per_day":"0"}}'
expect "settings: bad weekday -> 400" 400 "${J[@]}" -X PUT "$B/api/admin/settings" -d '{"settings":{"shoot_weekdays":"7"}}'
for sid in $SIDS; do curl -s -o /dev/null "${J[@]}" -X DELETE "$B/api/admin/sessions/$sid"; done
ok "removed test shoots"

echo "== settings, contracts, CSV"
expect "settings get" 200 "$B/api/admin/settings"
expect "settings bad hours -> 400" 400 "${J[@]}" -X PUT "$B/api/admin/settings" -d '{"settings":{"inquiry_reply_hours":"zero"}}'
expect "settings bad email -> 400" 400 "${J[@]}" -X PUT "$B/api/admin/settings" -d '{"settings":{"contact_email":"not-an-email"}}'
expect "settings save" 200 "${J[@]}" -X PUT "$B/api/admin/settings" -d '{"settings":{"hourly_rate_text":"$175/hour"}}'
expect "contracts list" 200 "$B/api/admin/contracts"
has "draft disclaimer" "not legal advice"
for k in clients sessions payments; do
  expect "export $k.csv" 200 -D "$TMP/h" "$B/api/admin/export/$k.csv"
  grep -qi "content-type: text/csv" "$TMP/h" && ok "$k.csv content-type" || bad "$k.csv content-type" "$(grep -i content-type "$TMP/h")"
done

echo "== Cal.com webhook"
cal() { # cal <name> <want> <body> [signature]
  local sig="${4:-$(printf '%s' "$3" | openssl dgst -sha256 -hmac "$CAL_SECRET" -r | cut -d' ' -f1)}"
  expect "$1" "$2" -X POST -H "content-type: application/json" -H "x-cal-signature-256: $sig" -d "$3" "$B/api/webhooks/cal"
}
NEW='{"triggerEvent":"BOOKING_CREATED","payload":{"uid":"smoke-uid-1","title":"Graduation session","startTime":"2026-12-05T22:00:00Z","endTime":"2026-12-05T23:30:00Z","attendees":[{"name":"Smoke Tester","email":"smoke@smoke.example"}]}}'
cal "webhook bad signature -> 401" 401 "$NEW" "0000"
cal "webhook missing signature -> 401" 401 "$NEW" " "
cal "webhook created" 200 "$NEW"
cal "webhook created retry is idempotent" 200 "$NEW"
cal "webhook rescheduled" 200 '{"triggerEvent":"BOOKING_RESCHEDULED","payload":{"uid":"smoke-uid-2","rescheduleUid":"smoke-uid-1","startTime":"2026-12-06T22:00:00Z","endTime":"2026-12-06T23:00:00Z","attendees":[{"name":"Smoke Tester","email":"smoke@smoke.example"}]}}'
cal "webhook cancelled" 200 '{"triggerEvent":"BOOKING_CANCELLED","payload":{"uid":"smoke-uid-2","cancellationReason":"Sick","attendees":[{"name":"Smoke Tester","email":"smoke@smoke.example"}]}}'
cal "webhook ping/other ignored" 200 '{"triggerEvent":"PING","payload":{}}'
expect "smoke client sessions after webhooks" 200 "$B/api/admin/clients?q=smoke%40smoke"
SMOKE_CID=$(node -e 'const o=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write((o.clients||[])[0]?.id||"")' < "$TMP/body")
expect "smoke client detail" 200 "$B/api/admin/clients/$SMOKE_CID"
has "rescheduled booking uid stored" "2026-12-06"
has "cancelled -> lost" '"status":"lost"'

echo "== galleries"
# Tiny valid JPEG (1x1) for upload tests.
printf '%s' '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=' | base64 -d > "$TMP/p.jpg"
expect "create gallery no title -> 400" 400 "${J[@]}" -X POST "$B/api/admin/galleries" -d '{}'
expect "create gallery linked to session" 201 "${J[@]}" -X POST "$B/api/admin/galleries" \
  -d "{\"title\":\"Smoke Gallery\",\"client_id\":\"$CID\",\"session_id\":\"$SID\",\"pin\":\"4321\",\"max_selections\":1,\"allow_downloads\":false}"
GID=$(jget gallery.id); SLUG=$(jget gallery.slug)
[ -n "$SLUG" ] && ok "gallery slug $SLUG" || bad "gallery slug" "$(head -c 200 "$TMP/body")"
for n in 1 2; do
  expect "upload photo $n" 201 -H "x-requested-with: fetch" -F "full=@$TMP/p.jpg;type=image/jpeg" -F "thumb=@$TMP/p.jpg;type=image/jpeg" \
    -F "filename=SMOKE_$n.jpg" -F width=1 -F height=1 "$B/api/admin/galleries/$GID/photos"
done
expect "re-upload is skipped" 200 -H "x-requested-with: fetch" -F "full=@$TMP/p.jpg;type=image/jpeg" -F "thumb=@$TMP/p.jpg;type=image/jpeg" -F "filename=SMOKE_1.jpg" "$B/api/admin/galleries/$GID/photos"
expect "upload non-jpeg -> 400" 400 -H "x-requested-with: fetch" -F "full=@$TMP/p.jpg;type=image/png" -F "thumb=@$TMP/p.jpg;type=image/png" -F "filename=x.png" "$B/api/admin/galleries/$GID/photos"
expect "gallery page /g/slug" 200 -D "$TMP/h" "$B/g/$SLUG"
grep -qi "x-robots-tag: noindex" "$TMP/h" && ok "gallery noindex" || bad "gallery noindex" "missing"
expect "locked without PIN" 401 "$B/api/g/$SLUG"
expect "wrong PIN" 401 "${J[@]}" -X POST "$B/api/g/$SLUG/unlock" -d '{"pin":"0000"}'
expect "unlock without fetch header -> 400" 400 -X POST -H "content-type: application/json" -d '{"pin":"4321"}' "$B/api/g/$SLUG/unlock"
expect "right PIN" 200 -c "$TMP/jar" "${J[@]}" -X POST "$B/api/g/$SLUG/unlock" -d '{"pin":"4321"}'
expect "gallery after unlock" 200 -b "$TMP/jar" "$B/api/g/$SLUG"
P1=$(node -e 'const o=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(o.photos[0].id)' < "$TMP/body")
P2=$(node -e 'const o=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(o.photos[1].id)' < "$TMP/body")
expect "thumb served" 200 -D "$TMP/h" -b "$TMP/jar" "$B/api/g/$SLUG/photos/$P1/thumb"
grep -qi "x-content-type-options: nosniff" "$TMP/h" && ok "image nosniff" || bad "image nosniff" "header missing"
printf '<html>not a jpeg</html>' > "$TMP/fake.jpg"
expect "upload fake JPEG (wrong bytes) -> 400" 400 -H "x-requested-with: fetch" -F "full=@$TMP/fake.jpg;type=image/jpeg" -F "thumb=@$TMP/fake.jpg;type=image/jpeg" -F "filename=fake.jpg" "$B/api/admin/galleries/$GID/photos"
expect "download disabled -> 403" 403 -b "$TMP/jar" "$B/api/g/$SLUG/photos/$P1/download"
expect "favorite 1" 200 -b "$TMP/jar" "${J[@]}" -X PUT "$B/api/g/$SLUG/photos/$P1/favorite" -d '{"favorite":true}'
expect "favorite 2 over limit -> 409" 409 -b "$TMP/jar" "${J[@]}" -X PUT "$B/api/g/$SLUG/photos/$P2/favorite" -d '{"favorite":true}'
expect "submit selections" 200 -b "$TMP/jar" "${J[@]}" -X POST "$B/api/g/$SLUG/submit" -d '{"note":"Love the first one"}'
sleep 1
expect "session moved to editing" 200 "$B/api/admin/sessions/$SID"
has "status editing" '"status":"editing"'
expect "client activity has favorites" 200 "$B/api/admin/clients/$CID"
has "favorites logged" "favorite"
expect "dashboard shows selections waiting" 200 "$B/api/admin/dashboard"
has "selections_waiting item" "selections_waiting"
expect "admin gallery detail shows posting permission" 200 "$B/api/admin/galleries/$GID"
has "posting permission on gallery" "can_post"
# PIN lockout: parallel wrong guesses use up the budget; then even the right PIN is refused.
for i in 1 2 3 4 5 6 7 8 9 10; do
  curl -s -o /dev/null "${J[@]}" -X POST "$B/api/g/$SLUG/unlock" -d "{\"pin\":\"99$i\"}" &
done
wait
expect "PIN locked after parallel guesses" 429 "${J[@]}" -X POST "$B/api/g/$SLUG/unlock" -d '{"pin":"4321"}'
expect "delete gallery" 200 "${J[@]}" -X DELETE "$B/api/admin/galleries/$GID"
expect "deleted gallery 404" 404 "$B/api/g/$SLUG"

echo "== cleanup"
expect "delete minor client" 200 "${J[@]}" -X DELETE "$B/api/admin/clients/$CID"
sql "DELETE FROM clients WHERE email LIKE '%@smoke.example'; DELETE FROM rate_limits;"
ok "removed *@smoke.example rows"

echo
echo "passed: $PASS  failed: $FAIL"
[ "$FAIL" = 0 ]
