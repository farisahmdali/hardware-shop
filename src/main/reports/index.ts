import { registerReports } from './engine';
import { salesReports } from './sales';
import { stockReports } from './stock';
import { rentalReports } from './rentals';
import { financialReports } from './financial';
import { partyReports } from './parties';

registerReports({ ...salesReports, ...stockReports, ...rentalReports, ...financialReports, ...partyReports });

export { runReport, hasReportImpl, type RunContext } from './engine';
