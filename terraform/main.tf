resource "digitalocean_ssh_key" "ops" {
  name       = "agentic-demo-ops"
  public_key = var.ops_ssh_public_key
}

locals {
  cloud_init = <<-EOF
    #cloud-config
    package_update: true
    packages:
      - git
      - curl
      - jq
    runcmd:
      - curl -fsSL https://get.docker.com | sh
  EOF

  # cust1 gets the agent key too, so the AI agent can ssh in
  cloud_init_customer = <<-EOF
    #cloud-config
    package_update: true
    packages:
      - git
      - curl
      - jq
    users:
      - name: root
        ssh_authorized_keys:
          - ${var.agent_ssh_public_key}
  EOF

  # db1 needs no docker and no root agent key: the agent reaches it only as
  # the unprivileged dbops user, which customer/db/setup.sh creates.
  cloud_init_db = <<-EOF
    #cloud-config
    package_update: true
    packages:
      - git
      - curl
      - jq
  EOF
}

resource "digitalocean_droplet" "core" {
  name      = "core.${var.domain}"
  region    = var.region
  size      = var.core_size
  image     = "ubuntu-24-04-x64"
  ssh_keys  = [digitalocean_ssh_key.ops.fingerprint]
  user_data = local.cloud_init
  tags      = ["agentic-demo"]
}

resource "digitalocean_droplet" "agent" {
  name      = "agent.${var.domain}"
  region    = var.region
  size      = var.agent_size
  image     = "ubuntu-24-04-x64"
  ssh_keys  = [digitalocean_ssh_key.ops.fingerprint]
  user_data = local.cloud_init
  tags      = ["agentic-demo"]
}

resource "digitalocean_droplet" "cust1" {
  name      = "cust1.${var.domain}"
  region    = var.region
  size      = var.customer_size
  image     = "ubuntu-24-04-x64"
  ssh_keys  = [digitalocean_ssh_key.ops.fingerprint]
  user_data = local.cloud_init_customer
  tags      = ["agentic-demo"]
}

resource "digitalocean_droplet" "db1" {
  name      = "db1.${var.domain}"
  region    = var.region
  size      = var.customer_size
  image     = "ubuntu-24-04-x64"
  ssh_keys  = [digitalocean_ssh_key.ops.fingerprint]
  user_data = local.cloud_init_db
  tags      = ["agentic-demo"]
}

resource "digitalocean_firewall" "demo" {
  name        = "agentic-demo"
  droplet_ids = [
    digitalocean_droplet.core.id,
    digitalocean_droplet.agent.id,
    digitalocean_droplet.cust1.id,
    digitalocean_droplet.db1.id,
  ]

  inbound_rule {
    protocol         = "tcp"
    port_range       = "22"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }
  inbound_rule {
    protocol         = "tcp"
    port_range       = "80"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }
  inbound_rule {
    protocol         = "tcp"
    port_range       = "443"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }
  inbound_rule {
    protocol         = "tcp"
    port_range       = "3000"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }
  inbound_rule {
    protocol         = "icmp"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }
  # postgres on db1, reachable only from inside the sandbox (app on cust1,
  # plus core for ad-hoc diagnosis) - never from the internet
  inbound_rule {
    protocol           = "tcp"
    port_range         = "5432"
    source_droplet_ids = [
      digitalocean_droplet.cust1.id,
      digitalocean_droplet.core.id,
    ]
  }

  outbound_rule {
    protocol              = "tcp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
  outbound_rule {
    protocol              = "udp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
  outbound_rule {
    protocol              = "icmp"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
}
