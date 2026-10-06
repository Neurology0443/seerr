const INDEPENDENT_DESTINATION_FIELD = 'independentRequestDestination';

export const hasIndependentRequestDestination = (body: {
  independentRequestDestination?: unknown;
}): boolean =>
  Object.prototype.hasOwnProperty.call(body, INDEPENDENT_DESTINATION_FIELD);

export const hasValidIndependentRequestDestination = (body: {
  independentRequestDestination?: unknown;
}): boolean =>
  !hasIndependentRequestDestination(body) ||
  typeof body.independentRequestDestination === 'boolean';
