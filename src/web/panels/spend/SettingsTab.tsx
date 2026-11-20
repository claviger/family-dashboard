import { useMe } from '../../shell/useMe.js';
import { BanksSettings } from './BanksSettings.js';
import { CardsSettings } from './CardsSettings.js';
import { CategoriesSettings } from './CategoriesSettings.js';
import { CsvImport } from './CsvImport.js';
import { MappingSettings } from './MappingSettings.js';
import { RulesSettings } from './RulesSettings.js';

/**
 * Spend settings (spec §12.12, admins only; the server checks every change): banks through Plaid
 * (only with Plaid's keys set), CSV import, cards and their closing dates, categories, rules, and
 * the Plaid category mapping (spec §12.7).
 */
export function SettingsTab() {
  const plaid = useMe().data!.features.plaid;
  return (
    <div className="spend-settings">
      {plaid && <BanksSettings />}
      <CsvImport />
      <CardsSettings />
      <CategoriesSettings />
      <RulesSettings />
      <MappingSettings plaidConfigured={plaid} />
    </div>
  );
}
