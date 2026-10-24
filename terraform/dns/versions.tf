terraform {
  required_version = ">= 1.5"
  required_providers {
    digitalocean = {
      source  = "digitalocean/digitalocean"
      version = "~> 2.40"
    }
  }
}

# The DNS zone lives in the personal account. This module has its own state and
# is never destroyed by teardown, so the records survive between labs.
provider "digitalocean" {
  alias = "dns"
  token = var.do_token_dns
}
