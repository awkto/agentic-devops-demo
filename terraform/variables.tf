variable "do_token_team" {
  description = "DigitalOcean API token for the account that hosts the droplets"
  type        = string
  sensitive   = true
}

variable "do_token_dns" {
  description = "DigitalOcean API token for the account that hosts the DNS zone"
  type        = string
  sensitive   = true
}

variable "domain" {
  description = "Base domain for the sandbox"
  type        = string
  default     = "gobyl.cc"
}

variable "region" {
  type    = string
  default = "syd1"
}

variable "ops_ssh_public_key" {
  description = "Public key installed as root on every droplet"
  type        = string
}

variable "agent_ssh_public_key" {
  description = "Public key the AI agent uses to reach customer hosts"
  type        = string
}

variable "core_size" {
  type    = string
  default = "s-8vcpu-16gb"
}

variable "agent_size" {
  type    = string
  default = "s-2vcpu-4gb"
}

variable "customer_size" {
  type    = string
  default = "s-1vcpu-2gb"
}
