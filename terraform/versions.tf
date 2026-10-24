terraform {
  required_version = ">= 1.5"
  required_providers {
    digitalocean = {
      source  = "digitalocean/digitalocean"
      version = "~> 2.40"
    }
  }
}

# Droplets live in the team account, DNS records live in terraform/dns (separate state).
provider "digitalocean" {
  token = var.do_token_team
}
