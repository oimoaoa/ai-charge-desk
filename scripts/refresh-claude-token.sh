#!/bin/sh
# SwiftBar "갱신하기" 버튼용: claude CLI 최소 호출로 토큰 갱신을 트리거한 "뒤에"
# 재수집 → 플러그인 재렌더 순서를 강제한다(swiftbar-refresh.sh와 같은 원리).
# 토큰은 여기서 직접 다루지 않는다 — 갱신 주체는 Claude Code CLI 본체(read-only 설계 유지).
# $1 = node 절대 경로(플러그인이 process.execPath로 넘겨줌 — SwiftBar 최소 PATH 대비)
NODE="$1"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
"$NODE" "$ROOT/scripts/refresh-claude-token.mjs" >/dev/null 2>&1
"$NODE" "$ROOT/scripts/build-snapshot.mjs" >/dev/null 2>&1
/usr/bin/open -g "swiftbar://refreshplugin?plugin=ai-charge-desk.2m.js"
