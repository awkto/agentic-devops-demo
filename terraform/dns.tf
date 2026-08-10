locals {
  core_records = ["chat", "sso", "tickets", "icinga", "wiki", "bao"]
}

resource "digitalocean_record" "core" {
  for_each = toset(local.core_records)
  provider = digitalocean.dns
  domain   = var.domain
  type     = "A"
  name     = each.key
  value    = digitalocean_droplet.core.ipv4_address
  ttl      = 300
}

resource "digitalocean_record" "agent" {
  provider = digitalocean.dns
  domain   = var.domain
  type     = "A"
  name     = "agent"
  value    = digitalocean_droplet.agent.ipv4_address
  ttl      = 300
}

resource "digitalocean_record" "cust1" {
  provider = digitalocean.dns
  domain   = var.domain
  type     = "A"
  name     = "cust1"
  value    = digitalocean_droplet.cust1.ipv4_address
  ttl      = 300
}
