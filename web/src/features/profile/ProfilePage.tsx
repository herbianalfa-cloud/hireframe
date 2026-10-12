import { AddFactForm } from './AddFactForm';
import { CvHeaderCard } from './CvHeaderCard';
import { DangerZone } from './DangerZone';
import { FactList } from './FactList';
import { useDocuments, useFacts } from './hooks';
import { ReviewSection } from './ReviewSection';
import { UploadCard } from './UploadCard';
import { WorkRightsCard } from './WorkRightsCard';

/** Profile: the fact library built from the CV and manual additions (PRD R2). */
export function ProfilePage() {
  const facts = useFacts();
  const documents = useDocuments();

  const active =
    facts.status === 'ready' ? facts.data.filter((v) => v.fact.status === 'active') : [];
  const review = facts.status === 'ready' ? facts.data.filter((v) => v.fact.review) : [];

  return (
    <section aria-labelledby="page-title" className="mx-auto max-w-5xl">
      <h1 id="page-title" className="text-xl font-semibold tracking-tight">
        Profile
      </h1>
      {facts.status === 'ready' ? (
        <p className="mt-1 text-sm text-muted-foreground">
          <span className="font-mono tabular-nums">{active.length}</span> active{' '}
          {active.length === 1 ? 'fact' : 'facts'} ·{' '}
          <span className="font-mono tabular-nums">{review.length}</span> need review
        </p>
      ) : null}
      <div className="mt-6 space-y-6">
        <UploadCard documents={documents} facts={facts} />
        {facts.status === 'ready' ? <ReviewSection facts={facts.data} /> : null}
        <AddFactForm />
        <WorkRightsCard />
        <CvHeaderCard />
        <FactList state={facts} />
        <DangerZone />
      </div>
    </section>
  );
}
