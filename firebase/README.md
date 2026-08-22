# Firebase 설정

VANTA는 작품 동기화용 Realtime Database와 선택적인 Live Cursor용 Realtime Database를 분리해 사용할 수 있습니다.

1. Firebase Console에서 자신의 Realtime Database 프로젝트를 만듭니다.
2. Sync 프로젝트에는 `database.rules.json`, Cursor 프로젝트에는 `cursor.database.rules.json`을 적용합니다.
3. `server/config.php`에 각 프로젝트의 Database URL, Web API Key, 서비스 계정 이메일과 Base64 인코딩된 개인 키를 입력합니다.
4. 규칙 배포 도구를 사용할 경우 프로젝트 ID와 인증 정보는 환경변수나 로컬 비밀 파일로 전달하고 Git에 커밋하지 않습니다.

`deploy-rules.mjs`와 `deploy-rules.php`는 예제 도구입니다. 적용 전 자신의 프로젝트 ID와 인증 방식을 검토하세요. 이 공개본에는 실제 VANTA Firebase 프로젝트의 데이터나 자격 증명이 없습니다.
