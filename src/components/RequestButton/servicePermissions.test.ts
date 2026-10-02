import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { canRequestService } from './servicePermissions';

describe('service request permissions', () => {
  it('allows managers without a grant or personal quality permission', () => {
    assert.equal(
      canRequestService({
        canManageService: true,
        hasGrant: false,
        hasQualityPermission: false,
      }),
      true
    );
  });

  it('allows regular users with both a grant and quality permission', () => {
    assert.equal(
      canRequestService({
        canManageService: false,
        hasGrant: true,
        hasQualityPermission: true,
      }),
      true
    );
  });

  it('rejects regular users without quality permission', () => {
    assert.equal(
      canRequestService({
        canManageService: false,
        hasGrant: true,
        hasQualityPermission: false,
      }),
      false
    );
  });

  it('rejects regular users without a target grant', () => {
    assert.equal(
      canRequestService({
        canManageService: false,
        hasGrant: false,
        hasQualityPermission: true,
      }),
      false
    );
  });
});
