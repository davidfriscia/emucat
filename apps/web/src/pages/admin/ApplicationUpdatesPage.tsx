import { ApplicationUpdates } from '../../components/ApplicationUpdates';
import { ServerInfoCard } from '../../components/SettingsCards';

/** What this installation runs, and updating it from its configured branch. */
export function ApplicationUpdatesPage() {
  return (
    <>
      <title>Application Updates · Admin · EmuCat</title>
      <h1 className="h3 mb-4" id="application-updates-title">
        Application Updates
      </h1>
      <div className="settings-grid">
        <section className="card settings-wide" aria-labelledby="application-updates-title">
          <div className="card-body">
            <ApplicationUpdates />
          </div>
        </section>
        <ServerInfoCard />
      </div>
      <p className="text-body-secondary small mt-4">
        Repositories are managed under Repositories. Agent and emulator settings live in each
        agent’s own configuration file.
      </p>
    </>
  );
}
