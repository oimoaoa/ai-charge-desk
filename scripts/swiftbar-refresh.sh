#!/bin/sh
# SwiftBar "새로고침" 버튼용: 데이터를 다시 수집한 "뒤에" 플러그인을 다시 그린다.
# 메뉴 항목의 refresh=true는 명령 종료를 기다린다는 보장이 문서에 없어(즉시 다시 그리면
# 옛 스냅샷이 이기는 경주 발생 — 두 번 눌러야 갱신되는 증상), 순서를 여기서 강제한다.
# $1 = node 절대 경로(플러그인이 process.execPath로 넘겨줌 — SwiftBar 최소 PATH 대비)
NODE="$1"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
"$NODE" "$ROOT/scripts/build-snapshot.mjs" >/dev/null 2>&1
/usr/bin/open -g "swiftbar://refreshplugin?plugin=ai-charge-desk.2m.js"
