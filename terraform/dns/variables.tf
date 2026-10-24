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

variable "core_ip" {
  description = "IPv4 address of the core droplet"
  type        = string
}

variable "agent_ip" {
  description = "IPv4 address of the agent droplet"
  type        = string
}

variable "cust1_ip" {
  description = "IPv4 address of the cust1 droplet"
  type        = string
}

variable "db1_ip" {
  description = "IPv4 address of the db1 droplet"
  type        = string
}
