locals {
  core_records = ["chat", "sso", "tickets", "icinga", "icinga-api", "wiki", "bao"]
}

resource "digitalocean_record" "core" {
  for_each = toset(local.core_records)
  provider = digitalocean.dns
  domain   = var.domain
  type     = "A"
  name     = each.key
  value    = var.core_ip
  ttl      = 300
}

resource "digitalocean_record" "agent" {
  provider = digitalocean.dns
  domain   = var.domain
  type     = "A"
  name     = "agent"
  value    = var.agent_ip
  ttl      = 300
}

resource "digitalocean_record" "cust1" {
  provider = digitalocean.dns
  domain   = var.domain
  type     = "A"
  name     = "cust1"
  value    = var.cust1_ip
  ttl      = 300
}

resource "digitalocean_record" "db1" {
  provider = digitalocean.dns
  domain   = var.domain
  type     = "A"
  name     = "db1"
  value    = var.db1_ip
  ttl      = 300
}
