-- 해킹은 범죄입니다. LLNKKR 서비스와 API를 악용하지 마세요.
SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS llnk_links (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  path_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  link_type VARCHAR(16) CHARACTER SET ascii NOT NULL DEFAULT 'url',
  target_url VARCHAR(2048) NOT NULL,
  source_extension_version VARCHAR(20) NOT NULL DEFAULT '',
  created_ip VARCHAR(45) NOT NULL DEFAULT '',
  created_user_agent VARCHAR(255) NOT NULL DEFAULT '',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  visit_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  last_visited_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_llnk_path_code (path_code),
  KEY idx_llnk_type_created (link_type, created_at),
  KEY idx_llnk_active_created (is_active, created_at),
  KEY idx_llnk_created_ip (created_ip, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS llnk_rate_counters (
  counter_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  scope VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  bucket_key VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_count INT UNSIGNED NOT NULL DEFAULT 0,
  expires_at DATETIME NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (counter_key),
  KEY idx_llnk_rate_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS llnk_ip_blocks (
  scope VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  ip_address VARCHAR(45) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  reason_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  blocked_until DATETIME NOT NULL,
  hit_count INT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (scope, ip_address),
  KEY idx_llnk_blocks_until (blocked_until)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS llnk_security_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  event_type VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  severity VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'warning',
  scope VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  ip_address VARCHAR(45) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '',
  request_path VARCHAR(512) NOT NULL DEFAULT '',
  action_taken VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '',
  detail_json TEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_llnk_security_created (created_at),
  KEY idx_llnk_security_ip (ip_address, created_at),
  KEY idx_llnk_security_type (event_type, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS llnk_link_visits (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  link_id BIGINT UNSIGNED NOT NULL,
  path_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  link_type VARCHAR(16) CHARACTER SET ascii NOT NULL DEFAULT 'url',
  target_url VARCHAR(2048) NOT NULL,
  ip_address VARCHAR(45) NOT NULL DEFAULT '',
  user_agent VARCHAR(255) NOT NULL DEFAULT '',
  referer VARCHAR(1024) NOT NULL DEFAULT '',
  request_uri VARCHAR(1024) NOT NULL DEFAULT '',
  accept_language VARCHAR(120) NOT NULL DEFAULT '',
  cf_country CHAR(2) NOT NULL DEFAULT '',
  cf_ray VARCHAR(80) NOT NULL DEFAULT '',
  method VARCHAR(12) NOT NULL DEFAULT 'GET',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_llnk_visits_link (link_id, id),
  KEY idx_llnk_visits_ip (ip_address, id),
  KEY idx_llnk_visits_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS llnk_access_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  request_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_path VARCHAR(512) NOT NULL DEFAULT '',
  query_string VARCHAR(1024) NOT NULL DEFAULT '',
  method VARCHAR(12) NOT NULL DEFAULT 'GET',
  request_host VARCHAR(255) NOT NULL DEFAULT '',
  status_code SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  duration_ms INT UNSIGNED NOT NULL DEFAULT 0,
  ip_address VARCHAR(45) NOT NULL DEFAULT '',
  user_agent VARCHAR(255) NOT NULL DEFAULT '',
  referer VARCHAR(1024) NOT NULL DEFAULT '',
  accept_language VARCHAR(120) NOT NULL DEFAULT '',
  cf_country CHAR(2) NOT NULL DEFAULT '',
  cf_ray VARCHAR(80) NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_llnk_access_request (request_id),
  KEY idx_llnk_access_created (created_at),
  KEY idx_llnk_access_ip (ip_address, created_at),
  KEY idx_llnk_access_status (status_code, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS llnk_request_sessions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  identity_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_path VARCHAR(512) NOT NULL DEFAULT '',
  method VARCHAR(12) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'GET',
  request_host VARCHAR(255) NOT NULL DEFAULT '',
  ip_address VARCHAR(45) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '',
  user_agent VARCHAR(255) NOT NULL DEFAULT '',
  referer VARCHAR(1024) NOT NULL DEFAULT '',
  cf_country CHAR(2) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '',
  first_status_code SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  last_status_code SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  request_count BIGINT UNSIGNED NOT NULL DEFAULT 1,
  success_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  error_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  rate_limited_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  auth_failure_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  total_duration_ms BIGINT UNSIGNED NOT NULL DEFAULT 0,
  max_duration_ms INT UNSIGNED NOT NULL DEFAULT 0,
  first_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_llnk_request_identity (identity_key, last_seen_at),
  KEY idx_llnk_request_ip (ip_address, last_seen_at),
  KEY idx_llnk_request_path (request_path(191), last_seen_at),
  KEY idx_llnk_request_last_seen (last_seen_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS llnk_link_visit_sessions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  identity_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  link_id BIGINT UNSIGNED NOT NULL,
  path_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  link_type VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'url',
  target_url VARCHAR(2048) NOT NULL,
  ip_address VARCHAR(45) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '',
  user_agent VARCHAR(255) NOT NULL DEFAULT '',
  referer VARCHAR(1024) NOT NULL DEFAULT '',
  request_uri VARCHAR(1024) NOT NULL DEFAULT '',
  accept_language VARCHAR(120) NOT NULL DEFAULT '',
  cf_country CHAR(2) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '',
  cf_ray VARCHAR(80) NOT NULL DEFAULT '',
  method VARCHAR(12) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'GET',
  visit_count BIGINT UNSIGNED NOT NULL DEFAULT 1,
  first_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_llnk_visit_identity (identity_key, last_seen_at),
  KEY idx_llnk_visit_link (link_id, last_seen_at),
  KEY idx_llnk_visit_ip (ip_address, last_seen_at),
  KEY idx_llnk_visit_last_seen (last_seen_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS llnk_api_keys (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  key_prefix VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  key_hash VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  display_name VARCHAR(120) NOT NULL,
  notes VARCHAR(500) NOT NULL DEFAULT '',
  daily_limit INT UNSIGNED NOT NULL DEFAULT 3000,
  minute_limit INT UNSIGNED NOT NULL DEFAULT 300,
  burst_limit INT UNSIGNED NOT NULL DEFAULT 60,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  request_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  created_link_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  last_used_at DATETIME NULL,
  last_used_ip VARCHAR(45) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '',
  expires_at DATETIME NULL,
  revoked_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_llnk_api_key_prefix (key_prefix),
  KEY idx_llnk_api_key_active (is_active, expires_at),
  KEY idx_llnk_api_key_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS llnk_article_comments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  article_key VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  body VARCHAR(1000) NOT NULL,
  body_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  ip_address VARCHAR(45) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '',
  user_agent VARCHAR(255) NOT NULL DEFAULT '',
  referer VARCHAR(1024) NOT NULL DEFAULT '',
  accept_language VARCHAR(120) NOT NULL DEFAULT '',
  cf_country CHAR(2) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '',
  cf_ray VARCHAR(80) NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_llnk_article_comments_article (article_key, created_at, id),
  KEY idx_llnk_article_comments_ip (ip_address, created_at),
  KEY idx_llnk_article_comments_duplicate (article_key, ip_address, body_hash, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS llnk_polls (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  path_code VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  question VARCHAR(160) NOT NULL,
  content_type VARCHAR(8) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'poll',
  correct_option_order TINYINT UNSIGNED NULL,
  total_votes INT UNSIGNED NOT NULL DEFAULT 0,
  source_extension_version VARCHAR(20) NOT NULL DEFAULT '',
  created_ip_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_llnk_poll_code (path_code),
  KEY idx_llnk_poll_active_created (is_active, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS llnk_poll_options (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  poll_id BIGINT UNSIGNED NOT NULL,
  option_order TINYINT UNSIGNED NOT NULL,
  label VARCHAR(100) NOT NULL,
  vote_count INT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_llnk_poll_option_order (poll_id, option_order),
  KEY idx_llnk_poll_option_poll (poll_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS llnk_poll_voters (
  poll_id BIGINT UNSIGNED NOT NULL,
  voter_ip_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  option_id BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (poll_id, voter_ip_hash),
  KEY idx_llnk_poll_voter_option (option_id),
  KEY idx_llnk_poll_voter_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS llnk_reposts (
  link_id BIGINT UNSIGNED NOT NULL,
  post_id CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  author_name VARCHAR(80) NOT NULL DEFAULT '',
  profile_url VARCHAR(255) NOT NULL DEFAULT '',
  posted_at VARCHAR(80) NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  image_url VARCHAR(2048) NOT NULL DEFAULT '',
  avatar_url VARCHAR(2048) NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (link_id),
  KEY idx_llnk_repost_post (post_id),
  KEY idx_llnk_repost_updated (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS llnk_vanta_rooms (
  room_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  sync_shard VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'sync_a',
  cursor_shard VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'cursor_a',
  chat_sequence BIGINT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  checked_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (room_id),
  KEY idx_llnk_vanta_rooms_checked (checked_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS llnk_vanta_chat_archive (
  archive_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  message_id CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  room_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  participant_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  display_name VARCHAR(80) NOT NULL DEFAULT '참여자',
  message_text VARCHAR(400) NOT NULL,
  sent_at_ms BIGINT UNSIGNED NOT NULL,
  sequence_number BIGINT UNSIGNED NOT NULL,
  cursor_shard VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'cursor_a',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (archive_id),
  UNIQUE KEY uq_llnk_vanta_chat_message (message_id),
  KEY idx_llnk_vanta_chat_sent (sent_at_ms, archive_id),
  KEY idx_llnk_vanta_chat_room (room_id, sequence_number),
  KEY idx_llnk_vanta_chat_name (display_name, sent_at_ms)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS llnk_vanta_sync_usage (
  room_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  chunk_count SMALLINT UNSIGNED NOT NULL,
  chunk_bytes BIGINT UNSIGNED NOT NULL,
  revision BIGINT UNSIGNED NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (room_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS llnk_vanta_sync_chunks (
  room_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  chunk_key VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  byte_size INT UNSIGNED NOT NULL,
  PRIMARY KEY (room_id, chunk_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS llnk_vanta_settings (
  setting_key VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  setting_value VARCHAR(255) NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (setting_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS llnk_vanta_ip_limits (
  ip_address VARCHAR(45) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  daily_token_limit INT UNSIGNED NULL,
  reset_credits INT UNSIGNED NOT NULL DEFAULT 0,
  reset_used_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  reset_used_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
  paused TINYINT(1) NOT NULL DEFAULT 0,
  note VARCHAR(255) NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (ip_address),
  KEY idx_llnk_vanta_ip_limits_paused (paused, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS llnk_vanta_ip_usage_daily (
  usage_date DATE NOT NULL,
  ip_address VARCHAR(45) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  used_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
  request_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
  bonus_tokens INT NOT NULL DEFAULT 0,
  create_count INT UNSIGNED NOT NULL DEFAULT 0,
  join_count INT UNSIGNED NOT NULL DEFAULT 0,
  sync_count INT UNSIGNED NOT NULL DEFAULT 0,
  chat_count INT UNSIGNED NOT NULL DEFAULT 0,
  heartbeat_count INT UNSIGNED NOT NULL DEFAULT 0,
  cursor_count INT UNSIGNED NOT NULL DEFAULT 0,
  create_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
  join_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
  sync_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
  chat_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
  heartbeat_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
  cursor_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
  denied_count INT UNSIGNED NOT NULL DEFAULT 0,
  last_event_kind VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '',
  last_room_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '',
  first_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (usage_date, ip_address),
  KEY idx_llnk_vanta_usage_date_bytes (usage_date, used_bytes),
  KEY idx_llnk_vanta_usage_last_seen (last_seen_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS llnk_vanta_cursor_leases (
  room_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  participant_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  installation_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  ip_address VARCHAR(45) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  accounted_until DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (room_id, participant_id),
  KEY idx_llnk_vanta_cursor_leases_expiry (accounted_until),
  KEY idx_llnk_vanta_cursor_leases_ip (ip_address, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS llnk_vanta_partner_codes (
  code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  label VARCHAR(80) NOT NULL DEFAULT '',
  grant_tokens INT UNSIGNED NOT NULL,
  grant_resets INT UNSIGNED NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  redemption_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  granted_tokens BIGINT UNSIGNED NOT NULL DEFAULT 0,
  granted_resets BIGINT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (code),
  KEY idx_llnk_vanta_partner_active (is_active, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS llnk_vanta_partner_redemptions (
  code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  ip_address VARCHAR(45) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  granted_tokens INT UNSIGNED NOT NULL,
  granted_resets INT UNSIGNED NOT NULL DEFAULT 0,
  redeemed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (code, ip_address),
  KEY idx_llnk_vanta_partner_redemption_ip (ip_address, redeemed_at),
  KEY idx_llnk_vanta_partner_redemption_recent (redeemed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS llnk_vanta_presence (
  room_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  participant_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  installation_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  ip_address VARCHAR(45) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  display_name VARCHAR(80) NOT NULL DEFAULT '참여자',
  country_code CHAR(2) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '',
  joined_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  accounted_at DATETIME NULL,
  expires_at DATETIME NOT NULL,
  PRIMARY KEY (room_id, participant_id),
  KEY idx_llnk_vanta_presence_ip (ip_address, last_seen_at),
  KEY idx_llnk_vanta_presence_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
