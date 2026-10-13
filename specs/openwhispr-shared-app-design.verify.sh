#!/usr/bin/env zsh
set -u
artifact="${1:-${0:A:h}/../outputs/openwhispr-shared-app-design.html}"
fail=0
pass(){ print "PASS  $1"; }; miss(){ print "FAIL  $1"; fail=1; }
if [[ -f "$artifact" ]]; then pass "artifact exists"; else miss "artifact exists"; fi
if [[ -f "$artifact" ]]; then
  rg -qi '<!doctype html>' "$artifact" && rg -q 'name="viewport"' "$artifact" && pass "HTML document and responsive viewport" || miss "HTML document and responsive viewport"
  rg -q '\{\{[^}]+\}\}' "$artifact" && miss "no unresolved template placeholders" || pass "no unresolved template placeholders"
  rg -qi '<(script|link)[^>]+(src|href)="https?://|@import[[:space:]]+url\(https?://' "$artifact" && miss "no external runtime dependencies" || pass "no external runtime dependencies"
  rg -Uq 'rel="icon"[[:space:]]+href="data:image/png;base64,' "$artifact" && pass "embedded favicon" || miss "embedded favicon"
  views_ok=1; for id in desktop iphone crm architecture; do rg -q "id=\"view-$id\"" "$artifact" || views_ok=0; done
  (( views_ok )) && pass "required product views" || miss "required product views"
  rg -q 'Interactive mockup — no microphone or OS access' "$artifact" && pass "persistent simulation disclosure" || miss "persistent simulation disclosure"
  rg -q 'data-product-proof="not-proven"' "$artifact" && pass "product proof remains unproven" || miss "product proof remains unproven"
  rg -q 'id="copyArchitecture"' "$artifact" && rg -q 'id="downloadAcceptance"' "$artifact" && pass "architecture and acceptance Markdown exports" || miss "architecture and acceptance Markdown exports"
  if node - "$artifact" <<'NODE'
const fs=require("fs"),html=fs.readFileSync(process.argv[2],"utf8");
const scripts=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(m=>m[1]);
if(!scripts.length)process.exit(1); for(const source of scripts)new Function(source);
NODE
  then pass "embedded JavaScript compiles"; else miss "embedded JavaScript compiles"; fi
fi
if (( fail )); then print "OVERALL FAIL"; exit 1; fi
print "OVERALL PASS"
