CREATE TABLE IF NOT EXISTS segmentation_parameters (
  id BIGINT NOT NULL AUTO_INCREMENT,
  param_group VARCHAR(50) NOT NULL,
  param_key VARCHAR(100) NOT NULL,
  param_value VARCHAR(255) NOT NULL,
  value_type VARCHAR(20) NOT NULL DEFAULT 'number',
  value_unit VARCHAR(20) DEFAULT NULL,
  description VARCHAR(255) DEFAULT NULL,
  is_active CHAR(1) NOT NULL DEFAULT 'Y',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_segmentation_parameters_key (param_key),
  KEY idx_segmentation_parameters_group_active (param_group, is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO segmentation_parameters (
  param_group,
  param_key,
  param_value,
  value_type,
  value_unit,
  description,
  is_active
) VALUES
  ('general', 'company_zip', '33434', 'string', 'zip', 'ZIP base de la empresa para calcular distance_miles.', 'Y'),
  ('general', 'distance_enabled', '1', 'boolean', 'flag', 'Activa o desactiva el calculo de distance_miles y distance_range.', 'Y'),
  ('eligibility', 'excluded_customer_type', 'internet', 'string', 'text', 'Tipo de cliente excluido del universo elegible.', 'Y'),
  ('eligibility', 'lookback_years', '3', 'number', 'years', 'Anios hacia atras para considerar clientes elegibles por LASTCHANGEDATE.', 'Y'),

  ('windows', 'invoice_window_30d_days', '30', 'number', 'days', 'Ventana en dias para invoices_last_30_days.', 'Y'),
  ('windows', 'invoice_window_90d_days', '90', 'number', 'days', 'Ventana en dias para invoices_last_90_days y regla active.', 'Y'),
  ('windows', 'invoice_window_6m_months', '6', 'number', 'months', 'Ventana en meses para invoices_last_6_months.', 'Y'),
  ('windows', 'invoice_window_12m_months', '12', 'number', 'months', 'Ventana en meses para invoices_last_12_months y varias reglas de engagement.', 'Y'),
  ('windows', 'invoice_window_24m_months', '24', 'number', 'months', 'Ventana en meses para invoices_last_24_months y total_spend_24m.', 'Y'),

  ('engagement', 'engagement_new_total_invoices', '1', 'number', 'count', 'Si total_invoices = este valor, el cliente queda como new.', 'Y'),
  ('engagement', 'engagement_inactive_months', '12', 'number', 'months', 'Meses sin compra para clasificar como inactive.', 'Y'),
  ('engagement', 'engagement_active_min_invoices', '1', 'number', 'count', 'Minimo de facturas en la ventana de 90 dias para clasificar como active.', 'Y'),
  ('engagement', 'engagement_loyal_min_invoices_12m', '6', 'number', 'count', 'Minimo de facturas en 12 meses para clasificar como loyal.', 'Y'),
  ('engagement', 'engagement_occasional_min_invoices_12m', '2', 'number', 'count', 'Minimo de facturas en 12 meses para clasificar como occasional.', 'Y'),
  ('engagement', 'engagement_occasional_max_invoices_12m', '5', 'number', 'count', 'Maximo de facturas en 12 meses para clasificar como occasional.', 'Y'),

  ('vip', 'vip_total_spend_min_amount', '500', 'number', 'usd', 'Monto minimo de gasto acumulado para clasificar como VIP.', 'Y'),
  ('vip', 'vip_invoices_min_count', '36', 'number', 'count', 'Cantidad de facturas en 12 meses para clasificar como VIP.', 'Y'),
  ('vip', 'vip_category_window_months', '24', 'number', 'months', 'Ventana en meses para buscar compras de categorias VIP.', 'Y'),
  ('vip', 'vip_product_categories', '21Mower,RideMowr', 'csv', 'list', 'Categorias de producto que disparan customer_potential = VIP.', 'Y'),
  ('customer_potential', 'customer_potential_repuestos_min_invoices_12m', '1', 'number', 'count', 'Minimo de facturas en 12 meses para clasificar como Repuestos.', 'Y'),
  ('customer_potential', 'customer_potential_repuestos_min_total_invoices', '2', 'number', 'count', 'Minimo de facturas historicas para clasificar como Repuestos.', 'Y'),

  ('warranty', 'warranty_1m_max_days', '30', 'number', 'days', 'Hasta cuantos dias faltantes mostrar Garantia vence 1 mes.', 'Y'),
  ('warranty', 'warranty_3m_max_days', '90', 'number', 'days', 'Hasta cuantos dias faltantes mostrar Garantia vence 3 meses.', 'Y'),
  ('warranty', 'warranty_6m_max_days', '180', 'number', 'days', 'Hasta cuantos dias faltantes mostrar Garantia vence 6 meses.', 'Y')
ON DUPLICATE KEY UPDATE
  param_group = VALUES(param_group),
  param_value = VALUES(param_value),
  value_type = VALUES(value_type),
  value_unit = VALUES(value_unit),
  description = VALUES(description),
  is_active = VALUES(is_active),
  updated_at = CURRENT_TIMESTAMP;
