terraform {
  required_version = ">= 1.5"
  required_providers {
    digitalocean = {
      source  = "digitalocean/digitalocean"
      version = "~> 2.40"
    }
  }
}

# Droplets live in the team account, the DNS zone lives in the personal account.
provider "digitalocean" {
  token = var.do_token_team
}

provider "digitalocean" {
  alias = "dns"
  token = var.do_token_dns
}
