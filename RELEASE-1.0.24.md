# VANTA 1.0.24 release

- 확장 프로그램: `1.0.24`
- 서버 release: `53`
- 동기화 protocol: `3`

## 변경 사항

- Fast 커서를 개인 설정에서 방 전체 설정으로 변경했습니다.
- 방장만 Fast 커서를 켜거나 끌 수 있고, 변경은 Sync Firebase의 방 메타데이터를 통해 모든 참여자에게 전달됩니다.
- 현재 참여자 전원의 Token 여유가 확인되어야 Fast 커서를 켤 수 있습니다.
- Fast 접속권 발급 중 Token 부족이 발생하면 서버가 방 전체를 기본 커서로 되돌립니다.
- `https://*.firebasedatabase.app/*` 권한을 설치 시 받는 필수 host permission으로 변경했습니다.
- Sync/Cursor Firebase 규칙과 서버 인증을 release 53으로 올렸습니다.

## 배포 순서

1. LLNKKR VANTA API를 release 53으로 배포합니다.
2. Sync A와 Cursor A Firebase 규칙을 release 53으로 배포합니다.
3. VANTA 777의 최저 버전을 `1.0.24`로 설정합니다.
4. 확장 프로그램 `1.0.24`를 배포합니다.

서버와 규칙을 먼저 올리면 기존 release 52 확장 프로그램은 연결이 종료됩니다. 확장 프로그램 업데이트가 승인될 때까지 서비스 공백을 피하려면 최저 버전 변경과 규칙 배포 시점을 스토어 승인에 맞춰야 합니다.
