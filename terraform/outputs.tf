output "core_ip" {
  value = digitalocean_droplet.core.ipv4_address
}

output "agent_ip" {
  value = digitalocean_droplet.agent.ipv4_address
}

output "cust1_ip" {
  value = digitalocean_droplet.cust1.ipv4_address
}

output "db1_ip" {
  value = digitalocean_droplet.db1.ipv4_address
}
