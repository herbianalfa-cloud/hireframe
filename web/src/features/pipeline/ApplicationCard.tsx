import type { Application, CvFileFormat, CvFileKind, Question } from '@hireframe/shared';
import {
  CircleCheck,
  CircleMinus,
  Download,
  ExternalLink,
  Loader2,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { VerdictBadge } from '@/features/jobs/VerdictBadge';
import { formatDate } from '@/lib/format';
import { saveBlob } from '@/lib/download';
import {
  answerQuestion,
  applicationErrorMessage,
  downloadCvFile,
  downloadErrorMessage,
  regenerateApplication,
  retryApplication,
  skipAllQuestions,
  skipQuestion,
  withdrawApplication,
  type ApplicationView,
  type PipelineStage,
} from '@/services/applications';

import { useAction, type ActionState } from './hooks';
import { BLOCKED_TEXT, ISSUE_TEXT, LEVEL_TEXT, MATCH_TEXT } from './labels';

const ANSWER_MAX = 2_000;
const NOTES_MAX = 500;

function Status({ action }: { action: ActionState }) {
  return (
    <div aria-live="polite">
      {action.error ? (
        <p role="alert" className="mt-2 text-sm text-danger">
          {action.error}
        </p>
      ) : action.notice ? (
        <p className="mt-2 text-sm text-muted-foreground">{action.notice}</p>
      ) : null}
    </div>
  );
}

function Spinner({ show }: { show: boolean }) {
  return show ? <Loader2 aria-hidden="true" className="animate-spin" /> : null;
}

// ---- Needs your input ----

function AnsweredLine({ question }: { question: Question }) {
  const answer = question.answer;
  if (!answer) return null;
  const answered = answer.kind === 'fact';
  const Icon = answered ? CircleCheck : CircleMinus;
  return (
    <li className="flex items-start gap-2 text-sm">
      <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <span>
        <span className="font-medium">{answered ? 'Answered' : 'Skipped'}</span>
        <span className="text-muted-foreground">: </span>
        {question.requirement}
      </span>
    </li>
  );
}

function QuestionCard({
  jobId,
  question,
  action,
}: {
  jobId: string;
  question: Question;
  action: ActionState;
}) {
  const [text, setText] = useState('');
  const inputId = `answer-${question.id}`;

  return (
    <li className="rounded-md border bg-background p-3">
      <p className="text-sm">{question.requirement}</p>
      <p className="mt-1 text-xs text-muted-foreground">
        {LEVEL_TEXT[question.level]} · {MATCH_TEXT[question.match]}
      </p>
      <Label htmlFor={inputId} className="mt-3 block">
        Your answer
      </Label>
      <Textarea
        id={inputId}
        className="mt-1.5"
        maxLength={ANSWER_MAX}
        value={text}
        placeholder="What have you done that covers this? Plain facts work best."
        onChange={(event) => {
          setText(event.target.value);
        }}
      />
      <div className="mt-2 flex flex-wrap gap-2">
        <Button
          disabled={action.pending || text.trim() === ''}
          onClick={() => {
            void action
              .run(() => answerQuestion(jobId, question.id, text), {
                fail: applicationErrorMessage,
                done: (result) =>
                  result.unanswered === 0
                    ? 'Saved as a fact on Profile. All questions are handled.'
                    : `Saved as a fact on Profile. ${String(result.unanswered)} left.`,
              })
              .then((result) => {
                if (result) setText('');
              });
          }}
        >
          <Spinner show={action.pending} />
          Answer
        </Button>
        <Button
          variant="secondary"
          disabled={action.pending}
          onClick={() => {
            void action.run(() => skipQuestion(jobId, question.id), {
              fail: applicationErrorMessage,
            });
          }}
        >
          Skip
        </Button>
      </div>
    </li>
  );
}

function NeedsInput({ application, action }: { application: Application; action: ActionState }) {
  const open = application.questions.filter((question) => !question.answer);
  const handled = application.questions.filter((question) => question.answer);
  return (
    <div className="mt-3">
      <p className="text-sm text-muted-foreground">
        These parts of the posting aren&apos;t covered by your profile yet. An answer becomes a fact
        on Profile that the CV can cite; skipping leaves it out.
      </p>
      {handled.length > 0 ? (
        <ul className="mt-3 space-y-1">
          {handled.map((question) => (
            <AnsweredLine key={question.id} question={question} />
          ))}
        </ul>
      ) : null}
      {open.length > 0 ? (
        <ul className="mt-3 space-y-3">
          {open.map((question) => (
            <QuestionCard
              key={question.id}
              jobId={application.jobId}
              question={question}
              action={action}
            />
          ))}
        </ul>
      ) : null}
      {open.length >= 2 ? (
        <Button
          variant="secondary"
          className="mt-3"
          disabled={action.pending}
          onClick={() => {
            void action.run(() => skipAllQuestions(application.jobId), {
              fail: applicationErrorMessage,
            });
          }}
        >
          Skip all
        </Button>
      ) : null}
    </div>
  );
}

// ---- Chosen (blocked) ----

function Blocked({ application, action }: { application: Application; action: ActionState }) {
  const code = application.blocked?.code;
  const issues = application.lastIssues ?? [];
  return (
    <div className="mt-3">
      <p className="text-sm">
        {code ? BLOCKED_TEXT[code] : 'This application is waiting to start. Retry to continue.'}
      </p>
      {code === 'invalid_output' && issues.length > 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">
          Last check failed because: {issues.map((issue) => ISSUE_TEXT[issue]).join('; ')}.
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        {code === 'cv_header_missing' ? (
          <Button asChild variant="secondary">
            <Link to="/profile">Add CV header</Link>
          </Button>
        ) : null}
        <Button
          disabled={action.pending}
          onClick={() => {
            void action.run(() => retryApplication(application.jobId), {
              fail: applicationErrorMessage,
              done: (result) =>
                result.blocked
                  ? `Still blocked: ${BLOCKED_TEXT[result.blocked]}`
                  : 'Started again.',
            });
          }}
        >
          <Spinner show={action.pending} />
          {action.pending ? null : <RotateCcw aria-hidden="true" />}
          Retry
        </Button>
      </div>
    </div>
  );
}

// ---- Generating ----

function Generating({ application }: { application: Application }) {
  const issues = application.lastIssues ?? [];
  return (
    <div className="mt-3 text-sm">
      <p>Writing your CV and cover note. Usually within 15 minutes.</p>
      {issues.length > 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">
          The first draft didn&apos;t pass the fact checks (
          {issues.map((issue) => ISSUE_TEXT[issue]).join('; ')}), so it is being written again.
        </p>
      ) : null}
    </div>
  );
}

// ---- Ready ----

const FILES: readonly { kind: CvFileKind; format: CvFileFormat; label: string; name: string }[] = [
  { kind: 'cv', format: 'pdf', label: 'CV .pdf', name: 'CV as PDF' },
  { kind: 'cv', format: 'docx', label: 'CV .docx', name: 'CV as Word document' },
  { kind: 'cover-note', format: 'pdf', label: 'Cover note .pdf', name: 'cover note as PDF' },
  {
    kind: 'cover-note',
    format: 'docx',
    label: 'Cover note .docx',
    name: 'cover note as Word document',
  },
];

function Ready({
  application,
  headerName,
  action,
}: {
  application: Application;
  headerName: string | undefined;
  action: ActionState;
}) {
  const [downloading, setDownloading] = useState<string>();
  const [downloadError, setDownloadError] = useState<string>();
  const [regenerating, setRegenerating] = useState(false);
  const [notes, setNotes] = useState('');
  const cvId = application.currentCvId;

  async function download(file: (typeof FILES)[number]) {
    if (!cvId) return;
    setDownloading(file.label);
    setDownloadError(undefined);
    try {
      const { blob, fileName } = await downloadCvFile({
        cvId,
        kind: file.kind,
        format: file.format,
        headerName,
        company: application.job.company,
      });
      saveBlob(blob, fileName);
    } catch (caught) {
      setDownloadError(downloadErrorMessage(caught));
    } finally {
      setDownloading(undefined);
    }
  }

  return (
    <div className="mt-3">
      {cvId ? (
        <>
          <p className="text-sm">
            Your CV and cover note are ready.
            {application.cvIds.length > 1
              ? ` This is version ${String(application.cvIds.length)}.`
              : ''}
          </p>
          <ul className="mt-2 flex flex-wrap gap-2" aria-label="Downloads">
            {FILES.map((file) => (
              <li key={file.label}>
                <Button
                  variant="secondary"
                  aria-label={`Download ${file.name}`}
                  disabled={downloading !== undefined}
                  onClick={() => {
                    void download(file);
                  }}
                >
                  {downloading === file.label ? (
                    <Loader2 aria-hidden="true" className="animate-spin" />
                  ) : (
                    <Download aria-hidden="true" />
                  )}
                  {file.label}
                </Button>
              </li>
            ))}
          </ul>
          {downloadError ? (
            <p role="alert" className="mt-2 text-sm text-danger">
              {downloadError}
            </p>
          ) : null}
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          This application has no CV version recorded. Regenerate to write one.
        </p>
      )}
      {application.notes ? (
        <p className="mt-2 text-xs text-muted-foreground">Last notes: {application.notes}</p>
      ) : null}
      {regenerating ? (
        <div className="mt-3 rounded-md border bg-background p-3">
          <Label htmlFor={`notes-${application.jobId}`}>What should change? (optional)</Label>
          <Textarea
            id={`notes-${application.jobId}`}
            className="mt-1.5"
            maxLength={NOTES_MAX}
            value={notes}
            placeholder="For example: lead with the reporting work, keep it shorter."
            onChange={(event) => {
              setNotes(event.target.value);
            }}
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Notes steer wording and emphasis. They can&apos;t add facts: add those on Profile. The
            current version is kept.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              disabled={action.pending}
              onClick={() => {
                void action
                  .run(() => regenerateApplication(application.jobId, notes), {
                    fail: applicationErrorMessage,
                    done: () => 'Writing a new version. Usually within 15 minutes.',
                  })
                  .then((result) => {
                    if (result) {
                      setRegenerating(false);
                      setNotes('');
                    }
                  });
              }}
            >
              <Spinner show={action.pending} />
              Regenerate
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setRegenerating(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button
          variant="secondary"
          className="mt-3"
          onClick={() => {
            setRegenerating(true);
          }}
        >
          <RotateCcw aria-hidden="true" />
          Regenerate with notes
        </Button>
      )}
    </div>
  );
}

// ---- Withdraw ----

function Withdraw({ application, action }: { application: Application; action: ActionState }) {
  const [confirming, setConfirming] = useState(false);
  const hasFiles = application.cvIds.length > 0;

  if (!confirming) {
    return (
      <Button
        variant="ghost"
        onClick={() => {
          setConfirming(true);
        }}
      >
        <Trash2 aria-hidden="true" />
        Withdraw
      </Button>
    );
  }
  return (
    <div
      role="group"
      aria-label="Confirm withdraw"
      className="w-full rounded-md border border-danger/40 p-3"
    >
      <p className="text-sm">
        Withdraw this application?{' '}
        {hasFiles
          ? 'You can keep the CV files or delete them.'
          : 'You can start it again later from the job.'}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button
          variant="danger"
          disabled={action.pending}
          onClick={() => {
            void action.run(() => withdrawApplication(application.jobId, false), {
              fail: applicationErrorMessage,
            });
          }}
        >
          <Spinner show={action.pending} />
          {hasFiles ? 'Withdraw, keep files' : 'Withdraw'}
        </Button>
        {hasFiles ? (
          <Button
            variant="danger"
            disabled={action.pending}
            onClick={() => {
              void action.run(() => withdrawApplication(application.jobId, true), {
                fail: applicationErrorMessage,
              });
            }}
          >
            Withdraw and delete files
          </Button>
        ) : null}
        <Button
          variant="ghost"
          disabled={action.pending}
          onClick={() => {
            setConfirming(false);
          }}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

// ---- The card ----

/**
 * One application. Every string comes from the job, the owner or the model, and is shown as
 * text only; nothing here is parsed as HTML.
 */
export function ApplicationCard({
  view,
  stage,
  headerName,
}: {
  view: ApplicationView;
  stage: PipelineStage;
  headerName: string | undefined;
}): ReactNode {
  const { application } = view;
  const action = useAction();
  return (
    <li className="rounded-lg border bg-surface p-3 md:p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium break-words">{application.job.title}</p>
          <p className="text-xs text-muted-foreground break-words">
            {application.job.company} ·{' '}
            {stage === 'applied'
              ? `marked applied ${formatDate(application.updatedAt)}`
              : `since ${formatDate(application.stageAt)}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <VerdictBadge verdict={application.job.verdict} />
          <Button asChild variant="ghost" size="icon">
            <Link
              to={`/jobs?job=${encodeURIComponent(application.jobId)}`}
              aria-label={`Open job: ${application.job.title}`}
            >
              <ExternalLink aria-hidden="true" />
            </Link>
          </Button>
        </div>
      </div>
      {stage === 'needs_input' ? <NeedsInput application={application} action={action} /> : null}
      {stage === 'chosen' ? <Blocked application={application} action={action} /> : null}
      {stage === 'generating' ? <Generating application={application} /> : null}
      {stage === 'ready' ? (
        <Ready application={application} headerName={headerName} action={action} />
      ) : null}
      {stage === 'applied' ? (
        <p className="mt-3 text-sm text-muted-foreground">
          Marked applied. Undo it from the job if that was a mistake.
        </p>
      ) : null}
      <Status action={action} />
      {stage !== 'applied' ? (
        <div className="mt-3 flex flex-wrap gap-2 border-t pt-3">
          <Withdraw application={application} action={action} />
        </div>
      ) : null}
    </li>
  );
}
