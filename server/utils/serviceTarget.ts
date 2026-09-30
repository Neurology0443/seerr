export type ServiceTargetConfig = {
  buttonLabel?: string | null;
  isDefault: boolean;
  syncEnabled: boolean;
};

export const normalizeButtonLabel = (
  value?: string | null
): string | undefined => {
  const normalized = value?.trim();
  return normalized || undefined;
};

export const isMultiServiceTarget = (
  service: Pick<ServiceTargetConfig, 'buttonLabel'>
): boolean => Boolean(normalizeButtonLabel(service.buttonLabel));

export const validateServiceTargetConfig = (
  service: ServiceTargetConfig
): string | undefined => {
  if (!isMultiServiceTarget(service)) return;
  if (service.isDefault) {
    return 'A multi-service target cannot be a default server.';
  }
  if (!service.syncEnabled) {
    return 'A multi-service target must have scanning enabled.';
  }
};
