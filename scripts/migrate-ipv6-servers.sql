-- Migrate: cụm server IPv6 — bảng ipv6_servers + cột server_id
CREATE TABLE IF NOT EXISTS `ipv6_servers` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `name` varchar(100) NOT NULL,
  `api_url` varchar(255) NOT NULL,
  `public_ip` varchar(64) NOT NULL DEFAULT '',
  `admin_key` varchar(512) NOT NULL DEFAULT '',
  `webhook_secret` varchar(512) NOT NULL DEFAULT '',
  `location` varchar(100) NOT NULL DEFAULT '',
  `status` tinyint(1) NOT NULL DEFAULT 1,
  `sort_order` int(11) NOT NULL DEFAULT 0,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Thêm cột server_id vào các bảng proxy (idempotent: check INFORMATION_SCHEMA)
-- MySQL không có ADD COLUMN IF NOT EXISTS ở 5.7, dùng procedure
DELIMITER $$
CREATE PROCEDURE _migrate_ipv6_server_cols()
BEGIN
  IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='proxy_products' AND COLUMN_NAME='server_id') THEN
    ALTER TABLE `proxy_products` ADD COLUMN `server_id` int(11) NULL DEFAULT NULL AFTER `api_mode`, ADD KEY `server_id` (`server_id`);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='proxy_orders' AND COLUMN_NAME='server_id') THEN
    ALTER TABLE `proxy_orders` ADD COLUMN `server_id` int(11) NULL DEFAULT NULL AFTER `product_id`, ADD KEY `server_id` (`server_id`);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='proxy_order_items' AND COLUMN_NAME='server_id') THEN
    ALTER TABLE `proxy_order_items` ADD COLUMN `server_id` int(11) NULL DEFAULT NULL AFTER `order_id`, ADD KEY `server_id` (`server_id`);
  END IF;
END$$
DELIMITER ;
CALL _migrate_ipv6_server_cols();
DROP PROCEDURE _migrate_ipv6_server_cols;

-- Seed 1 server mặc định từ options nếu ipv6_servers đang trống
-- Chạy bằng PHP sau khi migrate (auto-setup-ipv6.js hoặc manual): INSERT từ options
