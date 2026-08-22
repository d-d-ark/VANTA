import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, "..", "src", "content.js"), "utf8");
const styles = fs.readFileSync(path.join(here, "..", "styles", "vanta.css"), "utf8");

test("엔트리 닉네임은 표시용 텍스트로만 사용한다", () => {
  assert.match(source, /document\.getElementById\("__NEXT_DATA__"\)/);
  assert.match(source, /page\?\.props\?\.pageProps\?\.initialState\?\.common/);
  assert.match(source, /common\.user\.nickname/);
  assert.match(source, /Object\.prototype\.hasOwnProperty\.call\(common, "user"\)/);
  assert.doesNotMatch(source, /querySelectorAll\("\.css-13o7eu2\.eg4k6ki2"\)/);
  assert.match(source, /slice\(0, 20\)/);
  assert.match(source, /nickname === "기본형" \? "익명" : nickname/);
  assert.match(source, /initial\.textContent = Array\.from\(name\)\[0\] \|\| "\?"/);
  assert.match(source, /button\.title = owner \? `\$\{name\} · 방장` : name/);
  assert.match(source, /body\.textContent = String\(message\.text \|\| ""\)/);
});

test("참여 전에 실제 엔트리 닉네임을 기다려 임시 참여자 이름을 공개하지 않는다", () => {
  assert.match(source, /async function waitForDisplayName\(timeoutMs = 15000\)/);
  assert.match(source, /const displayName = await waitForDisplayName\(\)/);
  assert.doesNotMatch(source, /`참여자 \$\{state\.participantId\.slice/);
});

test("Live 진입 전에 엔트리 작품 복구 창의 아니요를 자동 선택한다", () => {
  assert.match(source, /querySelectorAll\("#EntryModal, #entry_global_dialog/);
  assert.match(source, /text\.includes\("저장하지 않고 종료한 작품"\)/);
  assert.match(source, /\.entry-modal-cancelButton\[data-value='cancel'\]/);
  assert.match(source, /new MouseEvent\("click", \{ bubbles: true, cancelable: true, view: window \}\)/);
  assert.match(source, /function watchEntryRecoveryDialog\(\)/);
  assert.match(source, /observer\.observe\(document\.documentElement, \{ childList: true, subtree: true \}\)/);
  assert.match(source, /injectRuntime\(\);\s*watchEntryRecoveryDialog\(\);/);
  assert.match(source, /await waitForEntryRecoveryDialog\(\);[\s\S]*VANTA_IMPORT_PROJECT/);
});

test("project snapshots are debounced and capped during continuous editing", () => {
  assert.match(source, /const PROJECT_SYNC_IDLE_MS = 1800/);
  assert.match(source, /const PROJECT_SYNC_MAX_WAIT_MS = 8000/);
  assert.match(source, /if \(state\.editPointerActive\) return/);
  assert.match(source, /idleFor < PROJECT_SYNC_IDLE_MS && waitingFor < PROJECT_SYNC_MAX_WAIT_MS/);
});

test("Live 전에는 엔트리 헤더 VANTA 버튼으로 패널을 열고 Live에서는 바로 표시한다", () => {
  assert.match(source, /const initialToken = new URL\(location\.href\)\.searchParams\.get\("vanta"\) \|\| ""/);
  assert.match(source, /token: initialToken/);
  assert.match(source, /panelCollapsed: false/);
  assert.match(source, /panelVisible: Boolean\(initialToken\)/);
  assert.match(source, /function ensureHeaderLauncher\(\)/);
  assert.match(source, /document\.getElementById\("header_help"\)/);
  assert.match(source, /actionBar\.insertBefore\(wrapper, actionBar\.firstElementChild\)/);
  assert.match(source, /image\.src = chrome\.runtime\.getURL\("assets\/V_2\.svg"\)/);
  assert.match(source, /button\.addEventListener\("click", \(\) => setPanelVisible\(!state\.panelVisible\)\)/);
  assert.match(source, /const open = state\.panelVisible/);
  assert.match(source, /state\.headerLauncherTimer = window\.setInterval\(ensureHeaderLauncher, 750\)/);
  assert.doesNotMatch(source, /if \(isVantaWorkspace\(\)\) \{\s*current\?\.remove\(\)/);
  assert.match(source, /root\.dataset\.launcherOpen = state\.panelVisible \? "1" : "0"/);
  assert.doesNotMatch(source, /brand\.addEventListener\("click", \(\) => \{\s*if \(!isVantaWorkspace\(\)\)/);
  assert.match(source, /brand\.addEventListener\("click", \(\) => \{\s*state\.panelCollapsed = !state\.panelCollapsed/);
  assert.match(source, /icon\.className = "vanta-entry-launcher-icon"/);
  assert.doesNotMatch(source, /referenceIcon/);
  assert.match(source, /button\.className = "vanta-entry-launcher-button"/);
  assert.doesNotMatch(source, /button\.className = referenceButton\.className/);
  assert.match(styles, /#vanta-root\[data-launcher-open="0"\][\s\S]*width: 0;[\s\S]*pointer-events: none/);
  assert.match(styles, /\.vanta-entry-launcher \.vanta-entry-launcher-icon img/);
  assert.match(styles, /\.vanta-entry-launcher \.vanta-entry-launcher-button::before,[\s\S]*::after[\s\S]*display: none !important/);
  assert.match(source, /visibilityMotion[\s\S]*"420ms"/);
  assert.match(source, /openHorizontalPadding[\s\S]*openBorderWidth[\s\S]*\* 2/);
  assert.match(styles, /--vanta-panel-horizontal-padding: 6px/);
});

test("새 설치에서 한 번만 단계형 사용법 튜토리얼을 표시한다", () => {
  assert.match(source, /const TUTORIAL_COMPLETED_KEY = "vanta\.tutorialCompleted\.v1"/);
  assert.match(source, /chrome\.storage\.local\.get\(\[UI_SETTINGS_KEY, TUTORIAL_COMPLETED_KEY\]\)/);
  assert.match(source, /state\.tutorialPending = \(!settings \|\| typeof settings !== "object"\)/);
  assert.match(source, /function tutorialSteps\(\)/);
  assert.match(source, /function showTutorial\(\)/);
  assert.match(source, /window\.requestAnimationFrame\(showTutorial\)/);
  assert.match(source, /chrome\.storage\.local\.set\(\{ \[TUTORIAL_COMPLETED_KEY\]: true \}\)/);
  assert.match(source, /\.vanta-share-button/);
  assert.match(source, /\.vanta-settings-toggle/);
  assert.match(styles, /#vanta-tutorial/);
  assert.match(styles, /\.vanta-tutorial-highlight[\s\S]*box-shadow:/);
  assert.match(styles, /@keyframes vanta-tutorial-enter/);
});

test("페이지별 연결 ID로 새로고침 전후 Live 연결을 구분한다", () => {
  assert.match(source, /connectionId: randomToken\(12\)/);
  assert.match(source, /type: "VANTA_ACQUIRE_LIVE"[\s\S]*connectionId: state\.connectionId/);
  assert.match(source, /type: "VANTA_HEARTBEAT_LIVE"[\s\S]*connectionId: state\.connectionId/);
  assert.match(source, /type: "VANTA_RELEASE_LIVE"[\s\S]*connectionId: state\.connectionId/);
});

test("원본 엔트리 작품 주소와 ID를 방 메타데이터로 전송하지 않는다", () => {
  assert.doesNotMatch(source, /sourceEntryId/);
  assert.doesNotMatch(source, /sourceUrl: location\.href/);
});

test("공유하기 버튼은 Material Sensors 아이콘을 사용한다", () => {
  assert.match(source, /sensors: "M7\.76 16\.24/);
  assert.match(source, /iconButton\("공유하기", "sensors", "vanta-share-button"\)/);
  assert.match(styles, /button\.vanta-share-button:disabled,[\s\S]*button\.vanta-settings-link-copy:disabled\s*\{\s*cursor: not-allowed/);
});

test("별도 Token 버튼 없이 구름 설정 버튼을 Live 전후에 표시한다", () => {
  assert.doesNotMatch(source, /quotaToggle = iconButton\("Token"/);
  assert.match(source, /cloud: "M19\.35 10\.04/);
  assert.match(source, /settings = iconButton\("설정", "cloud", "vanta-settings-toggle"\)/);
  assert.match(source, /type: "VANTA_GET_QUOTA"/);
  assert.match(source, /quotaValue\.dataset\.vantaSettingsQuota/);
  assert.match(source, /actions\.append\(settings, share\)/);
  assert.match(source, /maxParticipants: state\.maxParticipants/);
});

test("클립보드가 포커스를 잃어도 생성된 방으로 이동하고 공유를 실패 처리하지 않는다", () => {
  assert.match(source, /catch \(error\) \{\s*console\.warn\("\[VANTA\] 링크 복사 실패"/);
  assert.match(source, /copied: false/);
  assert.match(source, /location\.assign\(copyResult\.inviteUrl\)/);
  assert.match(source, /if \(result\.copied\) showCopyConfirmation\(copy\)/);
  assert.doesNotMatch(source, /const inviteUrl = await copyInviteLink\(\)/);
});

test("Live 커서는 최대 10Hz로 보내고 OFF일 때 네트워크 전송을 멈춘다", () => {
  assert.match(source, /previous\.x === nextPoint\.x[\s\S]*previous\.y === nextPoint\.y\) return;/);
  assert.match(source, /const LIVE_CURSOR_INTERVAL_MS = 100/);
  assert.match(source, /const CURSOR_KEEPALIVE_INTERVAL_MS = 2000/);
  assert.match(source, /type: "VANTA_UPDATE_CURSOR"/);
  assert.match(source, /const followRate = 0\.3/);
  assert.match(source, /cursor\.currentX \+ \(targetX - cursor\.currentX\) \* followRate/);
  assert.match(source, /liveCursorMode: state\.liveCursorMode/);
  assert.match(source, /seq: state\.cursorSequence/);
  assert.match(source, /serverAt > existing\.serverAt/);
  assert.match(source, /nextSequence > Number\(existing\.seq \|\| 0\)/);
  assert.match(source, /!state\.liveCursorMode[\s\S]*return/);
  assert.match(source, /Math\.max\(100, Math\.min\(190, sampleGap \* 1\.45\)\)/);
  assert.match(source, /function isCodeBoardViewportTarget\(target\)/);
  assert.match(source, /state\.codeBoardViewportGesture = isCodeBoardViewportTarget\(event\.target\)/);
  assert.match(source, /if \(state\.codeBoardViewportGesture\) return/);
  assert.match(source, /dataset\.otherContext/);
  assert.match(source, /sceneKey: cursorContextKey\(status\?\.sceneId\)/);
  assert.match(source, /area: "viewport"/);
  assert.match(source, /codeboard: \["\.entryWorkspaceBoard", "\.entryBoardWrapper"\]/);
  assert.match(source, /enginebar: \["\.entryEngineButtonWrapper"\]/);
  assert.match(source, /const CURSOR_AREA_ORDER = \[[\s\S]*"enginebar"[\s\S]*"stage"/);
  assert.match(source, /function codeBoardBlockIdentity\(block\)/);
  assert.match(source, /\.blockPath\[blockId\]/);
  assert.match(source, /path\?\.getAttribute\("blockId"\)/);
  assert.doesNotMatch(source, /return String\(block\.id \|\| ""\)/);
  assert.match(source, /function codeBoardBlockKey\(block, anchor = false\)/);
  assert.match(source, /function codeBoardBlockAt\(svg, blockKey, clientX, clientY\)/);
  assert.match(source, /function codeBoardCoordinateSpace\(blockKey = "", clientX = null, clientY = null\)/);
  assert.match(source, /svg\.querySelectorAll\("\.block\[id\]"\)/);
  assert.match(source, /codeBoardBlockKey\(element, anchor\) === blockKey/);
  assert.match(source, /document\.elementFromPoint\(clientX, clientY\)/);
  assert.match(source, /hit instanceof Element \? hit\.closest\("\.block\[id\]"\) : null/);
  assert.match(source, /const CODE_BOARD_ANCHOR_RANGE = 128/);
  assert.match(source, /function codeBoardAnchorKey\(blockKey\)/);
  assert.match(source, /function codeBoardNearestBlock\(svg, clientX, clientY\)/);
  assert.match(source, /anchorBlock = codeBoardNearestBlock\(svg, clientX, clientY\)/);
  assert.match(source, /function encodeCodeBoardAnchorOffset\(value\)/);
  assert.match(source, /function decodeCodeBoardAnchorOffset\(value\)/);
  assert.match(source, /codeBoard\.anchor \? encodeCodeBoardAnchorOffset\(rawX\) : rawX/);
  assert.match(source, /codeBoard\?\.anchor[\s\S]*decodeCodeBoardAnchorOffset\(cursor\.renderX\)/);
  assert.match(source, /function cursorCoordinateFromScreen\([\s\S]*allowCodeBoardReanchor = true[\s\S]*\) \{/);
  assert.match(source, /const wantsCodeBoardBlock = area === "codeboard" && Boolean\(blockKey\)/);
  assert.match(source, /area === "codeboard" && \(wantsCodeBoardBlock \|\| allowCodeBoardReanchor\)/);
  assert.match(source, /wantsCodeBoardBlock && !codeBoard && !allowCodeBoardReanchor\) return null/);
  assert.match(source, /codeBoardCoordinateSpace\(blockKey, clientX, clientY\)/);
  assert.match(source, /const rawX = \(clientX - codeBoard\.rect\.left\) \/ codeBoard\.rect\.width/);
  assert.match(source, /const targetRect = codeBoard\?\.rect \|\| rect/);
  assert.match(source, /const fallbackX = Math\.max\(0, Math\.min\(1, \(clientX - rect\.left\) \/ rect\.width\)\)/);
  assert.match(source, /fallbackX,[\s\S]*fallbackY,/);
  assert.doesNotMatch(source, /preferredBlockKey = area === "codeboard"/);
  assert.doesNotMatch(source, /if \(area === "codeboard"\) return null/);
  assert.match(source, /coordinateSpaceChanged && existing\.currentX !== null/);
  assert.match(source, /coordinateSpaceChanged[\s\S]*remappedCurrent\?\.x \?\? nextX/);
  assert.doesNotMatch(source, /screenMatrix|getScreenCTM|decodeCodeBoardCoordinate/);
  assert.match(source, /cursor\.area === "codeboard" && cursor\.blockKey && !otherContext[\s\S]*codeBoardCoordinateSpace\(cursor\.blockKey\)/);
  assert.match(source, /cursor\.area === "codeboard" && cursor\.blockKey && !otherContext && !codeBoard/);
  assert.match(source, /useCodeBoardFallback[\s\S]*cursor\.fallbackX \?\? cursor\.x/);
  assert.match(source, /cursor\.element\.hidden = cursor\.currentX === null \|\| cursor\.currentY === null/);
  assert.match(source, /blockmenu: \["\.entryWorkspaceBlockMenu", "\.blockMenuWrapper"\]/);
  assert.doesNotMatch(source, /stage: \[[^\n]+entryBoardWrapper/);
  assert.match(styles, /\.vanta-remote-cursor-pointer[\s\S]*border-radius: 50%/);
  assert.match(styles, /data-other-context="1"[\s\S]*opacity: \.45/);
  assert.match(source, /if \(left\.id === state\.participantId\) return -1/);
  assert.match(source, /focusParticipantCursor\(participant\.id\)/);
  assert.match(source, /Array\.from\(name\)\[0\] \|\| "\?"/);
});

test("색상 밝기에 따라 닉네임 글자를 검정 또는 흰색으로 표시한다", () => {
  assert.match(source, /function contrastTextColor\(value\)/);
  assert.match(source, /luminance > 0\.179 \? "#111111" : "#FFFFFF"/);
  assert.match(styles, /color: var\(--vanta-profile-foreground, #fff\)/);
  assert.match(styles, /color: var\(--vanta-cursor-foreground, #fff\)/);
});

test("좌표 판정 진단 기능은 사용자 설정에서 숨긴다", () => {
  assert.match(source, /cursorZonesVisible: false/);
  assert.match(source, /function updateCursorZoneOverlay\(\)/);
  assert.match(source, /CURSOR_ZONE_DEFINITIONS/);
  assert.match(source, /label\.textContent = `\$\{definition\.label\} · \$\{definition\.displayArea \|\| definition\.area\}`/);
  assert.doesNotMatch(source, /data-vanta-cursor-zones-toggle|vantaCursorZonesToggle/);
  assert.doesNotMatch(source, /textContent = "좌표 구역 보기"/);
  assert.doesNotMatch(source, /cursorZonesVisible: state\.cursorZonesVisible/);
  assert.match(source, /scenes: \["\.ne-header", "\.entrySceneWorkspace"/);
  assert.match(source, /label: "헤더", displayArea: "header"/);
  assert.match(source, /function updateCursorZoneProbe\(event\)/);
  assert.match(source, /블록 \$\{codeBoardBlockIdentity\(block\)\}/);
  assert.match(source, /보드 X \$\{\(ratioX \* 100\)\.toFixed\(1\)\}%/);
  assert.match(styles, /#vanta-cursor-zones[\s\S]*pointer-events: none/);
  assert.match(styles, /\.vanta-cursor-zone[\s\S]*background: color-mix/);
  assert.match(styles, /\.vanta-cursor-zone\[data-area="codeboard"\][\s\S]*background-size: 10% 10%/);
  assert.match(styles, /\.vanta-codeboard-probe/);
});

test("복사 완료 체크는 비율이 고정된 둥근 선 아이콘이다", () => {
  assert.match(source, /check: "M5 12\.5l4\.2 4L19 7\.5"/);
  assert.match(source, /svg\.setAttribute\("preserveAspectRatio", "xMidYMid meet"\)/);
  assert.match(source, /path\.setAttribute\("stroke-linecap", "round"\)/);
  assert.match(styles, /button\.vanta-icon-button svg[\s\S]*aspect-ratio: 1/);
  assert.match(styles, /button\.vanta-icon-button\.vanta-settings-link-copy\s*\{[\s\S]*?width: 26px;[\s\S]*?height: 26px;/);
  assert.match(styles, /button\.vanta-icon-button\.vanta-settings-link-copy svg\s*\{[\s\S]*?width: 16px;[\s\S]*?height: 16px;/);
});

test("현재 참여 인원은 패널에 항상 숫자로 표시한다", () => {
  assert.match(source, /participantCount\.textContent = `\$\{state\.participantCount\}\/\$\{state\.maxParticipants\}`/);
  assert.match(source, /data-vanta-participant-count/);
  assert.match(styles, /\.vanta-participant-count/);
});

test("참여자 프로필은 검은 트레이로 펼쳐지고 클릭하면 해당 편집 위치로 이동한다", () => {
  assert.match(source, /profileToggle = iconButton\("참여자 보기", "group"/);
  assert.match(source, /state\.profileDockOpen = !state\.profileDockOpen/);
  assert.match(source, /if \(state\.panelCollapsed\)[\s\S]*state\.profileDockOpen = false/);
  assert.match(source, /profileDock\.inert = !state\.profileDockOpen/);
  assert.match(styles, /\.vanta-profile-dock\[data-open="1"\]/);
  assert.match(styles, /\.vanta-profile-area[\s\S]*background: var\(--vanta-panel\)/);
  assert.match(styles, /\.vanta-profile-area[\s\S]*border-radius: 12px/);
  assert.match(styles, /button\.vanta-profile-toggle[\s\S]*background: transparent/);
  assert.match(styles, /--vanta-panel-height: 40px/);
  assert.match(styles, /\.vanta-profile-area[\s\S]*height: var\(--vanta-panel-height\)/);
  assert.match(styles, /data-collapsed="1"\][\s\S]*\.vanta-profile-area[\s\S]*translate\(-16px, -50%\) scale\(\.82\)/);
  assert.match(styles, /\.vanta-profile-list[\s\S]*background: transparent/);
  assert.match(source, /type,?\s*"VANTA_FOCUS_CURSOR_CONTEXT"|"VANTA_FOCUS_CURSOR_CONTEXT"/);
  assert.match(source, /sceneKey: cursor\.sceneKey/);
  assert.match(source, /objectKey: cursor\.objectKey/);
  assert.doesNotMatch(source, /vanta-profile-name|vanta-profile-measure|dataset\.expanded/);
  assert.doesNotMatch(styles, /vanta-profile-name|vanta-profile-measure|data-expanded/);
});

test("서버가 확인한 방장 프로필은 왕관 대신 테두리로 강조한다", () => {
  assert.match(source, /const owner = participant\.isOwner === true/);
  assert.match(source, /button\.dataset\.owner = owner \? "1" : "0"/);
  assert.match(source, /owner \? `\$\{name\} · 방장` : name/);
  assert.match(styles, /vanta-profile\[data-owner="1"\][\s\S]*border: 3px solid #FFD45C/);
  assert.match(styles, /button\.vanta-profile[\s\S]*justify-content: center/);
  assert.match(styles, /\.vanta-profile-initial[\s\S]*font-weight: 800/);
  assert.doesNotMatch(source, /vanta-profile-crown|setElementIcon\(crown/);
  assert.doesNotMatch(styles, /vanta-profile-crown/);
});

test("프로필 호버는 떠오르지 않고 색상만 어두워진다", () => {
  assert.match(styles, /button\.vanta-profile:hover\s*\{\s*filter: brightness\(\.76\)/);
  assert.doesNotMatch(styles, /button\.vanta-profile:hover\s*\{[^}]*translateY/s);
});

test("채팅은 100자 3줄이며 최신 20개를 실시간으로 표시한다", () => {
  assert.match(source, /const CHAT_MAX_LENGTH = 100/);
  assert.match(source, /const CHAT_HISTORY_LIMIT = 20/);
  assert.match(source, /text\.split\("\\n"\)\.length > 3/);
  assert.match(source, /\.slice\(-CHAT_HISTORY_LIMIT\)/);
  assert.match(source, /type: "VANTA_SEND_CHAT"/);
  assert.match(source, /if \(message\?\.type === "CHAT"\) receiveChatMessages/);
  assert.match(source, /state\.chatCloseTimer = window\.setTimeout/);
  assert.match(source, /const optimisticId = `pending-/);
  assert.match(source, /state\.chatMessages = \[\.\.\.state\.chatMessages, optimisticMessage\]/);
  assert.match(source, /textarea\.value = "";[\s\S]*renderChat\(\);[\s\S]*VANTA_SEND_CHAT/);
  assert.match(source, /filter\(\(message\) => message\.id !== optimisticId/);
  assert.match(styles, /#vanta-chat\s*\{[\s\S]*left: 22px/);
  assert.match(styles, /#vanta-chat\[data-open="0"\][\s\S]*translate\(0, calc\(100% \+ 24px\)\)/);
  assert.match(source, /toggle\.dataset\.active = state\.chatOpen \? "1" : "0"/);
  assert.match(styles, /vanta-chat-toggle\[data-active="1"\]/);
  assert.match(source, /function makeChatDraggable\(panel, handle\)/);
  assert.match(source, /localStorage\.setItem\("vanta\.chatPosition"/);
  assert.match(source, /const CHAT_POSITION_VERSION = 3/);
  assert.match(source, /value\?\.version === CHAT_POSITION_VERSION/);
  assert.match(source, /panel\.hidden \|\| panel\.getBoundingClientRect\(\)\.width < 1/);
  assert.match(source, /panel\.dataset\.positionPending === "1"[\s\S]*applyChatPosition\(panel\)/);
  assert.match(source, /function replaceChatList\(list, nodes\)/);
  assert.match(source, /anchoredBottom - rect\.height/);
  assert.match(source, /list\.scrollTop = list\.scrollHeight/);
  assert.match(source, /iconButton\("최소화", "minimize"/);
  assert.match(source, /iconButton\("위치 초기화", "refresh"/);
  assert.match(source, /iconButton\("닫기", "close"/);
  assert.match(source, /panel\.dataset\.minimized = state\.chatMinimized/);
  assert.match(styles, /vanta-chat-list[\s\S]*max-height: min\(380px, calc\(100vh - 170px\)\)[\s\S]*overflow-y: auto/);
  assert.match(styles, /scrollbar-color: #7351FF #161820/);
  assert.match(styles, /vanta-chat-list::\-webkit-scrollbar-thumb[\s\S]*background: #7351FF/);
  assert.match(source, /panel\.style\.left = "22px"[\s\S]*panel\.style\.bottom = "22px"/);
  assert.match(styles, /data-minimized="1"[\s\S]*vanta-chat-list > :last-child \{ display: flex; \}/);
});

test("방장이 아닌 참여자에게 최대 인원 버튼은 금지 커서를 표시한다", () => {
  assert.match(source, /button\.dataset\.forbidden = ownerLocked \? "1" : "0"/);
  assert.match(styles, /vanta-room-size button\[data-forbidden="1"\]:disabled[\s\S]*cursor: not-allowed/);
  assert.match(styles, /button\.vanta-switch\[data-forbidden="1"\]:disabled[\s\S]*cursor: not-allowed/);
});

test("작품과 변경 용량은 서버 요청 전에 제한하고 초과 시 Live를 안전하게 끝낸다", () => {
  assert.match(source, /participantCount: state\.participantCount/);
  assert.match(source, /function isProjectSizeError\(error\)/);
  assert.match(source, /stopSession\(`\$\{shortErrorMessage\(error, "용량 초과"\)\}로 Live가 종료됐습니다\.`\)/);
});

test("변경 효과 코드와 스타일은 완전히 제거된다", () => {
  assert.doesNotMatch(source, /glitch|remoteChangeAreas|vantaEffectToggle/i);
  assert.doesNotMatch(styles, /glitch|vanta-change-scan/i);
});

test("채팅 전송 버튼은 위 화살표 대신 종이비행기 아이콘을 사용한다", () => {
  assert.match(source, /send: "M2\.01 21 23 12/);
  assert.match(source, /setElementIcon\(send, "send"\)/);
  assert.doesNotMatch(source, /send\.textContent = "↑"/);
});

test("settings drawer keeps the cloud icon stable and opens smoothly from non-Live state", () => {
  assert.match(source, /settings = iconButton\("설정", "cloud", "vanta-settings-toggle"\)/);
  assert.match(source, /root\.dataset\.live = isVantaWorkspace\(\) \? "1" : "0"/);
  assert.doesNotMatch(
    styles,
    /\.vanta-settings-toggle\[data-active="1"\]\s+svg\s*\{[^}]*rotate\(/s,
  );
  assert.match(
    styles,
    /\.vanta-settings-drawer[\s\S]*transition:[^;]*max-height 520ms/,
  );
  assert.doesNotMatch(styles, /transition:[^;]*max-width 520ms/);
  assert.match(styles, /grid-auto-rows:\s*max-content/);
  assert.match(styles, /data-settings-closing="1"\] \.vanta-settings-drawer/);
  assert.match(source, /rowsHeight = rows\.reduce/);
  assert.match(
    styles,
    /#vanta-root\[data-settings-open="1"\] \.vanta-panel-content[\s\S]*max-width: none/,
  );
  assert.match(
    styles,
    /#vanta-root\[data-settings-open="1"\] \.vanta-actions[\s\S]*margin-left: auto/,
  );
  assert.match(styles, /\.vanta-settings-drawer[\s\S]*width: 100%[\s\S]*justify-self: stretch/);
  assert.match(styles, /\.vanta-settings-row[\s\S]*width: 100%/);
  assert.match(styles, /\.vanta-settings-row[\s\S]*height: 32px;[\s\S]*min-height: 32px/);
  assert.doesNotMatch(styles, /\.vanta-settings-live-cursor\s*\{[^}]*min-height:\s*38px/s);
  assert.match(styles, /#vanta-root\s*\{[\s\S]*transition:[^;]*width var\(--vanta-panel-width-duration, 280ms\)/);
  assert.doesNotMatch(styles, /data-width-(?:measuring|animating)/);
  assert.doesNotMatch(source, /widthMeasuring|widthAnimating|panelWidthTimer/);
  assert.match(styles, /\.vanta-top-row[\s\S]*min-width: 0/);
  assert.doesNotMatch(styles, /\.vanta-top-row\s*\{[^}]*overflow: hidden/s);
  assert.match(styles, /\.vanta-panel-content[\s\S]*min-width: 0/);
  assert.match(styles, /\.vanta-panel-content[\s\S]*flex: 1 1 auto/);
  assert.match(styles, /\.vanta-actions[\s\S]*flex: 0 0 auto/);
  assert.match(styles, /\.vanta-actions[\s\S]*margin-left: auto/);
  assert.match(styles, /data-collapsed="1"\] \.vanta-panel-content[\s\S]*justify-content: flex-end/);
  assert.match(source, /function naturalFlexWidth\(element, depth = 0\)/);
  assert.match(source, /const rectWidth = Number\(child\.getBoundingClientRect\(\)\.width\) \|\| 0/);
  assert.match(source, /const offsetWidth = Number\(child\.offsetWidth\) \|\| 0/);
  assert.match(source, /const scrollWidth = Number\(child\.scrollWidth\) \|\| 0/);
  assert.match(source, /Math\.max\([\s\S]*rectWidth[\s\S]*offsetWidth[\s\S]*scrollWidth[\s\S]*directChildrenWidth/);
  assert.match(source, /const autoAlignedActions = child\.classList\?\.contains\("vanta-actions"\) === true/);
  assert.match(source, /const margins = autoAlignedActions[\s\S]*\? 0[\s\S]*marginLeft[\s\S]*marginRight/);
  assert.match(source, /function naturalPanelWidth\(root, content, contentWidth\)/);
  assert.match(source, /brandWidth \+ expandedContentWidth/);
  assert.match(source, /getPropertyValue\("--vanta-panel-content-open-margin"\)/);
  assert.match(styles, /--vanta-panel-content-open-margin: 2px/);
  assert.match(styles, /\.vanta-panel-content\.vanta-share-content[\s\S]*--vanta-panel-content-open-margin: 10px/);
  assert.match(source, /root\.dataset\.settingsOpen === "1"/);
  assert.doesNotMatch(source, /root\.dataset\.settingsOpen === "1" \|\| root\.dataset\.settingsClosing === "1"/);
  assert.match(source, /const targetWidth = root\.dataset\.launcherOpen === "0"[\s\S]*Math\.max\(1, naturalPanelWidth\(root, content, measuredContentWidth\)\)/);
  assert.doesNotMatch(source, /root\.style\.width = "auto"/);
  assert.match(source, /function observePanelMeasurements\(root\)/);
  assert.match(source, /new ResizeObserver\(\(\) => updatePanelContentWidth\(root\)\)/);
  assert.match(source, /new MutationObserver\(\(\) => updatePanelContentWidth\(root\)\)/);
  assert.match(source, /targetWidth > currentWidth \? "280ms" : "340ms"/);
});

test("초기 연결 실패는 재시도를 위해 Live 방을 보존한다", () => {
  assert.match(source, /catch \(error\) \{[\s\S]*showRetry\(true\);[\s\S]*releaseLive\(\{ preserveRoom: true \}\)/);
  assert.match(source, /preserveRoom: options\.preserveRoom === true/);
});

test("settings drawer shows the full short link and room-wide Live cursor controls", () => {
  assert.match(source, /type: "VANTA_SHORTEN_LINK", url: sourceUrl/);
  assert.match(source, /linkText\.dataset\.vantaSettingsLink = "1"/);
  assert.match(source, /copySettingsLink\(linkCopy\)/);
  assert.match(source, /if \(!state\.settingsLink\) await loadSettingsLink\(\)/);
  assert.match(source, /linkCopy\.disabled = !state\.connected \|\| state\.settingsLinkLoading/);
  assert.match(source, /if \(state\.settingsOpen\) \{[\s\S]*loadSettingsLink\(\)/);
  assert.match(styles, /\.vanta-settings-link[\s\S]*overflow-wrap: anywhere/);
  assert.doesNotMatch(styles, /\.vanta-settings-link\s*\{[^}]*text-overflow:\s*ellipsis/s);
  assert.match(source, /liveCursorMode: false/);
  assert.doesNotMatch(source, /liveCursorIcon|vanta-live-cursor-icon/);
  assert.match(source, /liveCursorText\.textContent = "Live 커서"/);
  assert.match(source, /liveCursorDescription\.textContent = "OFF 시 토큰 절약"/);
  assert.match(source, /토큰이 부족해 Live 커서를 사용할 수 없습니다/);
  assert.match(styles, /\.vanta-live-cursor-label[\s\S]*grid-template-columns:\s*auto auto/);
  assert.match(source, /dataset\.vantaLiveCursorToggle = "1"/);
  assert.match(source, /liveCursorRow\.className = "vanta-settings-row vanta-settings-live-cursor"/);
  assert.doesNotMatch(styles, /\.vanta-live-cursor-icon/);
  assert.doesNotMatch(styles, /vanta-settings-live-cursor\[data-enabled="1"\][\s\S]*#FFB02E/);
  assert.doesNotMatch(source, /LIVE_CURSORS/);
  assert.match(source, /type: "VANTA_SET_LIVE_CURSOR"/);
  assert.match(source, /LIVE_CURSOR_UNAVAILABLE/);
});

test("익명 모드와 6자리 HEX 프로필·포인터 색상을 로컬 설정으로 제공한다", () => {
  assert.match(source, /anonymousMode: false/);
  assert.match(source, /if \(state\.anonymousMode\) return "익명"/);
  assert.match(source, /dataset\.vantaAnonymousToggle = "1"/);
  assert.match(source, /dataset\.vantaColorInput = "1"/);
  assert.match(source, /\^\[0-9A-Fa-f\]\{6\}\$/);
  assert.match(source, /color: profileColor\(\)/);
  assert.match(styles, /--vanta-cursor-color/);
  assert.match(source, /const PROFILE_COLOR_PALETTE = \[/);
  assert.match(source, /function randomPaletteColor\(\)/);
  assert.match(source, /PROFILE_COLOR_PALETTE\[value % PROFILE_COLOR_PALETTE\.length\]/);
  const palette = source.match(/const PROFILE_COLOR_PALETTE = \[([\s\S]*?)\];/)?.[1] || "";
  assert.equal(palette.match(/#[0-9A-F]{6}/g)?.length, 10);
  assert.doesNotMatch(palette, /#7351FF/);
});

test("보유한 토큰 초기화를 설정에서 한 번씩 사용할 수 있다", () => {
  assert.match(source, /type: "VANTA_USE_QUOTA_RESET"/);
  assert.match(source, /quotaResetLabel\.textContent = "토큰 초기화"/);
  assert.match(source, /quotaResetButton\.textContent = "사용하기"/);
  assert.match(source, /quotaResetRow\.hidden = resetCredits < 1 && !state\.quotaResetComplete/);
  assert.match(source, /quotaResetButton\.textContent = state\.quotaResetComplete/);
  assert.match(source, /updateSettingsMotionMetrics\(root\)/);
  assert.match(styles, /--vanta-settings-open-height/);
  assert.match(source, /setStatus\("토큰 초기화 완료", "success"\)/);
  assert.match(styles, /\.vanta-quota-reset-actions/);
  assert.match(styles, /\.vanta-settings-row\[hidden\][\s\S]*display: none !important/);
});

test("연결 끝내기 버튼은 호버하면 빨간색으로 바뀐다", () => {
  assert.match(source, /vanta-secondary vanta-disconnect-button/);
  assert.match(styles, /\.vanta-disconnect-button:hover[\s\S]*background: #D83B52/);
});

test("Live 종료 안내는 작품 저장 문장을 항상 덧붙인다", () => {
  assert.match(source, /작업을 보관하려면 작품을 저장하세요\./);
  assert.match(source, /base\.includes\(SAVE_WORK_NOTICE\)/);
});

test("room stream updates the participant limit and room-wide Live cursor setting", () => {
  assert.match(source, /message\?\.type === "ROOM_SETTINGS"/);
  assert.match(source, /name: getDisplayName\(\)/);
  assert.match(source, /function saveUiSettings\(\)[\s\S]*anonymousMode: state\.anonymousMode,[\s\S]*userColor: state\.userColor/);
  assert.match(source, /ROOM_SETTINGS[\s\S]{0,300}applyLiveCursorTransport\(message\.liveCursor === true\)/);
  assert.match(source, /VANTA_UPDATE_ROOM_SETTINGS[\s\S]{0,200}liveCursor: next/);
  assert.match(source, /liveCursorToggle\.disabled = state\.roomSettingsSaving \|\| liveCursorLocked/);
  assert.match(source, /liveCursorDesired/);
  assert.match(source, /liveCursorTransition/);
  assert.match(source, /while \(isCurrentConnection\(epoch, token\)[\s\S]*state\.liveCursorDesired !== state\.liveCursorMode/);
});

test("block dragging is previewed live without replaying Entry commands", () => {
  assert.match(source, /blockDragCandidate: null/);
  assert.match(source, /const block = event\.target instanceof Element \? event\.target\.closest\("\.block\[id\]"\) : null/);
  assert.match(source, /\(dx \* dx\) \+ \(dy \* dy\) >= 16/);
  assert.match(source, /dragging: Boolean\(state\.localBlockDrag\)/);
  assert.match(source, /dragBlockKey: state\.localBlockDrag\?\.blockKey/);
  assert.match(source, /function createRemoteBlockDrag\(cursor\)/);
  assert.match(source, /cloneNode\(true\)/);
  assert.match(source, /function updateRemoteBlockDrag\(cursor, otherContext\)/);
  assert.match(source, /cursor\.currentX - width \* cursor\.dragOffsetX/);
  assert.match(source, /clearRemoteBlockDrag\(cursor\)/);
  assert.match(styles, /\.vanta-remote-block-drag[\s\S]*pointer-events: none/);
  assert.doesNotMatch(source, /Entry\.do\([^\n]+drag/i);
});
