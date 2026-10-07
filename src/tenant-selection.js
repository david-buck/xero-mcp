export function selectTenant(connections, configuredTenantId) {
  if (configuredTenantId) {
    const tenant = connections.find((connection) => connection.tenantId === configuredTenantId);
    if (!tenant) throw new Error(`XERO_TENANT_ID ${configuredTenantId} is not available to this authorised user.`);
    return tenant;
  }
  if (connections.length === 0) throw new Error("No Xero organisations were connected for this authorised user.");
  if (connections.length !== 1) {
    const choices = connections.map((connection) => `${connection.tenantName ?? "Unnamed organisation"}: ${connection.tenantId}`).join("\n");
    throw new Error(`Multiple Xero organisations are connected. Set XERO_TENANT_ID in .env to your intended organisation and run auth again:\n${choices}`);
  }
  return connections[0];
}
