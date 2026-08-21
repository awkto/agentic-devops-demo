{
  "realm": "demo",
  "enabled": true,
  "users": [
    {
      "username": "sysadmin",
      "enabled": true,
      "email": "admin@__DOMAIN__",
      "firstName": "Sys",
      "lastName": "Admin",
      "emailVerified": true,
      "attributes": { "gitlab_id": ["1000"] },
      "credentials": [
        { "type": "password", "value": "__DEMO_USER_PASSWORD__", "temporary": false }
      ]
    },
    {
      "username": "alice",
      "enabled": true,
      "email": "alice@__DOMAIN__",
      "firstName": "Alice",
      "lastName": "Engineer",
      "emailVerified": true,
      "attributes": { "gitlab_id": ["1001"] },
      "credentials": [
        { "type": "password", "value": "__DEMO_USER_PASSWORD__", "temporary": false }
      ]
    },
    {
      "username": "bob",
      "enabled": true,
      "email": "bob@__DOMAIN__",
      "firstName": "Bob",
      "lastName": "Engineer",
      "emailVerified": true,
      "attributes": { "gitlab_id": ["1002"] },
      "credentials": [
        { "type": "password", "value": "__DEMO_USER_PASSWORD__", "temporary": false }
      ]
    }
  ],
  "clients": [
    {
      "clientId": "openbao",
      "name": "OpenBao",
      "protocol": "openid-connect",
      "enabled": true,
      "publicClient": false,
      "secret": "__OIDC_CLIENT_SECRET__",
      "standardFlowEnabled": true,
      "directAccessGrantsEnabled": false,
      "redirectUris": [
        "https://bao.__DOMAIN__/ui/vault/auth/oidc/oidc/callback",
        "http://localhost:8250/oidc/callback"
      ]
    },
    {
      "clientId": "mattermost",
      "name": "Mattermost (GitLab-endpoint shim)",
      "protocol": "openid-connect",
      "enabled": true,
      "publicClient": false,
      "secret": "__OIDC_CLIENT_SECRET__",
      "standardFlowEnabled": true,
      "directAccessGrantsEnabled": false,
      "redirectUris": ["https://chat.__DOMAIN__/*"],
      "protocolMappers": [
        {
          "name": "gitlab-id",
          "protocol": "openid-connect",
          "protocolMapper": "oidc-usermodel-attribute-mapper",
          "config": {
            "user.attribute": "gitlab_id",
            "claim.name": "id",
            "jsonType.label": "long",
            "id.token.claim": "true",
            "access.token.claim": "true",
            "userinfo.token.claim": "true"
          }
        },
        {
          "name": "gitlab-username",
          "protocol": "openid-connect",
          "protocolMapper": "oidc-usermodel-property-mapper",
          "config": {
            "user.attribute": "username",
            "claim.name": "username",
            "jsonType.label": "String",
            "id.token.claim": "true",
            "access.token.claim": "true",
            "userinfo.token.claim": "true"
          }
        },
        {
          "name": "gitlab-name",
          "protocol": "openid-connect",
          "protocolMapper": "oidc-full-name-mapper",
          "config": {
            "id.token.claim": "true",
            "access.token.claim": "true",
            "userinfo.token.claim": "true"
          }
        }
      ]
    },
    {
      "clientId": "https://tickets.__DOMAIN__/auth/saml/metadata",
      "name": "Zammad (SAML)",
      "protocol": "saml",
      "enabled": true,
      "redirectUris": ["https://tickets.__DOMAIN__/auth/saml/callback"],
      "attributes": {
        "saml.assertion.signature": "true",
        "saml.client.signature": "false",
        "saml.authnstatement": "true",
        "saml_name_id_format": "email",
        "saml.force.post.binding": "true"
      },
      "fullScopeAllowed": true
    }
  ]
}
