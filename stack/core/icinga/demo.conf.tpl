// Rendered by setup/icinga-init.sh with envsubst, installed to
// /data/etc/icinga2/conf.d/demo.conf inside the icinga2 container.

object ApiUser "icingaweb" {
  password = "${ICINGA_API_PASSWORD}"
  permissions = [ "*" ]
}

object ApiUser "agent" {
  password = "${ICINGA_API_PASSWORD}"
  permissions = [ "*" ]
}

object Host "cust1" {
  import "generic-host"
  address = "${CUST1_IP}"
  vars.customer = "cust1"
  vars.fqdn = "cust1.${DOMAIN}"
}

object Service "website" {
  host_name = "cust1"
  import "generic-service"
  check_command = "http"
  vars.http_address = "cust1.${DOMAIN}"
  vars.http_vhost = "cust1.${DOMAIN}"
  check_interval = 30s
  retry_interval = 15s
  max_check_attempts = 2
}

object Service "nodeapp" {
  host_name = "cust1"
  import "generic-service"
  check_command = "http"
  vars.http_address = "cust1.${DOMAIN}"
  vars.http_port = 3000
  vars.http_expect = "200"
  check_interval = 30s
  retry_interval = 15s
  max_check_attempts = 2
}

object Service "disk" {
  host_name = "cust1"
  import "generic-service"
  check_command = "by_ssh"
  vars.by_ssh_command = [ "/usr/lib/nagios/plugins/check_disk", "-w", "15%", "-c", "8%", "-p", "/" ]
  vars.by_ssh_logname = "root"
  vars.by_ssh_identity = "/data/ssh/agent_ed25519"
  vars.by_ssh_options = [ "StrictHostKeyChecking=accept-new", "UserKnownHostsFile=/data/ssh/known_hosts" ]
  check_interval = 60s
  retry_interval = 30s
  max_check_attempts = 2
}

object Service "postgres" {
  host_name = "cust1"
  import "generic-service"
  check_command = "by_ssh"
  vars.by_ssh_command = [ "/opt/checks/check_postgres.sh" ]
  vars.by_ssh_logname = "root"
  vars.by_ssh_identity = "/data/ssh/agent_ed25519"
  vars.by_ssh_options = [ "StrictHostKeyChecking=accept-new", "UserKnownHostsFile=/data/ssh/known_hosts" ]
  check_interval = 60s
  retry_interval = 30s
  max_check_attempts = 2
}

object User "agent" {
  display_name = "AI Agent"
}

object NotificationCommand "agent-webhook" {
  command = [ "/data/scripts/notify-agent.sh" ]
  env = {
    NOTIFY_HOST = "$host.name$"
    NOTIFY_HOST_ADDRESS = "$host.address$"
    NOTIFY_SERVICE = "$service.name$"
    NOTIFY_STATE = "$service.state$"
    NOTIFY_OUTPUT = "$service.output$"
    NOTIFY_TYPE = "$notification.type$"
    AGENT_WEBHOOK_URL = "${AGENT_WEBHOOK_URL}"
    WEBHOOK_SECRET = "${WEBHOOK_SECRET}"
  }
}

apply Notification "agent" to Service {
  command = "agent-webhook"
  users = [ "agent" ]
  types = [ Problem, Recovery ]
  interval = 0
  assign where host.name == "cust1"
}
