# VANTA 1.0.25 release

- 확장 프로그램: `1.0.25`
- 서버 release: `53`
- 동기화 protocol: `3`

## 변경 사항

- 참여자 스트림에서 Firebase 방 메타데이터의 `ownerUid`와 활성 참여자의 서버 인증 UID를 비교해 `isOwner`를 계산합니다.
- 방장 프로필 오른쪽 위에 작은 금색 왕관과 `방장` 툴팁을 표시합니다.
- 닉네임, 참여자 ID 또는 클라이언트가 임의로 보낸 값은 방장 판정에 사용하지 않습니다.
- Fast 작품 동기화는 Firebase 직접 쓰기로 변경하지 않았습니다. 작품 delta는 계속 LLNKKR에서 크기·경로·Token·revision을 검증한 뒤 Sync Firebase에 반영합니다.

ZIP은 별도 요청이 있을 때만 생성합니다.
