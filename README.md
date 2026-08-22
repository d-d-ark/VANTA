# VANTA 공개 아카이브

VANTA는 playentry.org 워크스페이스에서 최대 5명이 함께 작업할 수 있도록 만든 실시간 협업 Chrome 확장 프로그램입니다. 이 저장소는 최종 기능판과 서버·Firebase 구성을 자신의 인프라에서 재현할 수 있도록 공개한 아카이브입니다.

## 포함된 버전

- `extension/`: 최종 기능판 **v1.1.25**
- `server/api/v1/vanta/`: PHP API와 MySQL 스키마 생성 코드
- `firebase/`: Sync와 Live Cursor용 Realtime Database 규칙 및 배포 도구
- `sunset/vanta-v1.1.26/`: 설치된 확장 프로그램을 제거하는 종료 업데이트 소스
- `release/VANTA-v1.1.26.zip`: Chrome Web Store 제출용 종료 업데이트

## 직접 실행하기

1. PHP 8.1 이상, MySQL 8/MariaDB 10.6 이상과 Firebase Realtime Database 프로젝트를 준비합니다.
2. `server/config.example.php`를 `server/config.php`로 복사하고 자신의 DB·Firebase 서비스 계정·무작위 비밀값을 입력합니다.
3. 웹 루트를 `server/`로 지정하고 `firebase/README.md`에 따라 자신의 프로젝트에 규칙을 배포합니다.
4. `extension/src/background.js`의 API 기준 주소를 자신의 도메인으로 변경합니다.
5. Chrome에서 `extension/`을 압축하거나 개발자 모드로 로드합니다.

실제 LLNKKR DB, Firebase 키·서비스 계정, 채팅·IP·사용량 데이터, 운영 로그와 배포 비밀은 포함하지 않습니다.

코드는 [MIT License](LICENSE)로 공개합니다. VANTA 명칭과 로고는 [TRADEMARKS.md](TRADEMARKS.md)를 따릅니다.
