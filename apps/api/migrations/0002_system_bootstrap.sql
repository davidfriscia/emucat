-- Records that the one-time first-administrator setup has happened.
--
-- A single-row table whose primary key is fixed by a CHECK makes "setup happens at most once" a
-- database invariant, like the others in decision 0004: of any number of concurrent attempts, on any
-- number of API instances, exactly one INSERT can succeed. The row is never removed by the
-- application, even if that administrator is later deleted, so setup cannot become a way to take over
-- an installation.
CREATE TABLE system_bootstrap (
  id TINYINT UNSIGNED NOT NULL,
  admin_user_id UUID NULL,
  completed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_system_bootstrap_admin (admin_user_id),
  CONSTRAINT ck_system_bootstrap_single_row CHECK (id = 1),
  CONSTRAINT fk_system_bootstrap_admin FOREIGN KEY (admin_user_id)
    REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

-- An installation that already has an administrator has nothing left to bootstrap.
INSERT INTO system_bootstrap (id, admin_user_id)
  SELECT 1, id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1;
