interface ServicePermissionOptions {
  canManageService: boolean;
  hasGrant: boolean;
  hasQualityPermission: boolean;
}

export const canRequestService = ({
  canManageService,
  hasGrant,
  hasQualityPermission,
}: ServicePermissionOptions): boolean =>
  canManageService || (hasGrant && hasQualityPermission);
