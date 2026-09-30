import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isMultiServiceTarget,
  normalizeButtonLabel,
  validateServiceTargetConfig,
} from './serviceTarget';

describe('service target classification', () => {
  for (const buttonLabel of [undefined, '', '   ']) {
    it(`${JSON.stringify(buttonLabel)} is native`, () => {
      assert.equal(isMultiServiceTarget({ buttonLabel }), false);
    });
  }
  it('normalizes and classifies labels', () => {
    assert.equal(normalizeButtonLabel(' Deutsch '), 'Deutsch');
    assert.equal(isMultiServiceTarget({ buttonLabel: 'Deutsch' }), true);
  });
  it('rejects ambiguous multi-service targets', () => {
    assert.match(
      validateServiceTargetConfig({
        buttonLabel: 'Deutsch',
        isDefault: true,
        syncEnabled: true,
      }) ?? '',
      /default/
    );
    assert.match(
      validateServiceTargetConfig({
        buttonLabel: 'Deutsch',
        isDefault: false,
        syncEnabled: false,
      }) ?? '',
      /scanning/
    );
  });
  for (const target of [
    { buttonLabel: 'Deutsch', isDefault: false, syncEnabled: true },
    { buttonLabel: undefined, isDefault: true, syncEnabled: true },
    { buttonLabel: undefined, isDefault: false, syncEnabled: false },
  ]) {
    it(`accepts ${target.buttonLabel ?? 'native'} target`, () => {
      assert.equal(validateServiceTargetConfig(target), undefined);
    });
  }
});
