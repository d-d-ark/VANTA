# VANTA 1.0.22 release

## 호환 정책

- 확장 프로그램: `1.0.22`
- LLNKKR 서버: release `52`
- Sync Firebase 규칙: release `52`
- Cursor Firebase 규칙: release `52`
- 이전 확장 프로그램과 기존 방은 연결하지 않는다.

## 변경 사항

- 전체 작품을 통째로 덮어쓰는 구버전 저장 분기를 제거했다.
- `syncVersion 1` revision 스트림과 구버전 원격 적용 큐를 제거했다.
- Firebase snapshot 규칙에서 초기화 placeholder 외의 구버전 전체 작품 문자열을 거부한다.
- 서버는 조각형 `syncVersion 2`, protocol 3, release 52만 허용한다.
- Cursor Firebase의 빈 장면·오브젝트·블록 키 검증을 명시적 빈 문자열 비교로 고쳐 Fast 커서 좌표 쓰기를 허용한다.

## 운영 전환 순서

1. LLNKKR VANTA API와 `/vanta777`을 release 52로 배포한다.
2. Sync와 Cursor Firebase 규칙을 release 52로 게시한다.
3. VANTA 777의 최저 버전을 `1.0.22`로 설정한다.
4. Chrome에서 공유 생성과 두 번째 브라우저 연결을 확인한다.
