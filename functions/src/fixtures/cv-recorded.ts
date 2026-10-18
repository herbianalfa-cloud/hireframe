/**
 * Two recorded CV answers from the first LIVE CV eval (fake candidate "Alex Example", EVAL_FACTS):
 * a case 4 (near miss) draft and revision, and a case 5 (wildcard) draft and revision. Tests use them
 * to pin what the loop does with real model output: the inflated-claim check, clamping, and the
 * revision that fails to validate. Fake data only; not the owner's.
 */
export const RECORDED = {
  c04: {
    draft: {
      summary: {
        text: 'Recent Business Information Systems graduate with First Class Honours and a customer onboarding internship at a cloud software company. Based in London and available to start immediately.',
        factRefs: ['F34', 'F35', 'F1', 'F56', 'F57'],
      },
      experience: [
        {
          heading: { role: 'Customer Onboarding Intern', org: 'Example Cloud Ltd', factRef: 'F1' },
          bullets: [
            {
              text: 'Led onboarding for 12 clients and cut client time-to-live by 30%.',
              factRefs: ['F2', 'F3'],
            },
            {
              text: 'Presented a monthly churn-risk summary to the head of customer success.',
              factRefs: ['F10'],
            },
            {
              text: 'Resolved 200 support tickets and used Zendesk for customer support.',
              factRefs: ['F11', 'F60'],
            },
            {
              text: 'Mapped the onboarding process in Miro and removed 4 manual handoffs.',
              factRefs: ['F8', 'F9'],
            },
            {
              text: 'Ran weekly product feedback sessions with the support team.',
              factRefs: ['F5'],
            },
          ],
        },
        {
          heading: { role: 'Student Product Analyst', org: 'Campus Apps Society', factRef: 'F12' },
          bullets: [
            {
              text: 'Built a SQL dashboard in Metabase that tracked weekly active users.',
              factRefs: ['F13', 'F14'],
            },
            { text: 'Grew weekly active users by 45%.', factRefs: ['F16'] },
            {
              text: 'Interviewed 18 students to shape the timetable app roadmap.',
              factRefs: ['F15'],
            },
            {
              text: 'Ran an A/B test on the sign-up screen and lifted sign-up completion by 12%.',
              factRefs: ['F20', 'F21'],
            },
          ],
        },
        {
          heading: { role: 'Retail Assistant', org: 'Example Books', factRef: 'F22' },
          bullets: [
            {
              text: 'Handled customer queries on the shop floor and by phone.',
              factRefs: ['F23', 'F24'],
            },
            { text: 'Trained 3 new starters on the till system.', factRefs: ['F25'] },
          ],
        },
      ],
      projects: [
        {
          heading: { role: 'Olist e-commerce analysis', org: 'Personal project', factRef: 'F26' },
          bullets: [
            { text: 'Cleaned 100k orders in Python.', factRefs: ['F27'] },
            {
              text: 'Presented delivery-delay findings from the Olist analysis.',
              factRefs: ['F28'],
            },
          ],
        },
        {
          heading: { role: 'Timetable chatbot prototype', org: 'Personal project', factRef: 'F29' },
          bullets: [
            { text: 'Built a prompt-based FAQ bot with the Claude API.', factRefs: ['F30'] },
          ],
        },
      ],
      education: [
        { line: 'BSc Business Information Systems, Example University', factRef: 'F34' },
        { line: 'Google Data Analytics Certificate', factRef: 'F37' },
        { line: 'Scrum Fundamentals Certificate', factRef: 'F38' },
      ],
      skills: [
        { label: 'SQL', factRefs: ['F39'] },
        { label: 'Python', factRefs: ['F40'] },
        { label: 'Excel', factRefs: ['F41'] },
        { label: 'Metabase', factRefs: ['F42'] },
        { label: 'Jira', factRefs: ['F43'] },
        { label: 'Miro', factRefs: ['F48'] },
        { label: 'Zapier', factRefs: ['F49'] },
        { label: 'Process mapping', factRefs: ['F52'] },
        { label: 'User interviews', factRefs: ['F50'] },
        { label: 'A/B test analysis', factRefs: ['F51'] },
      ],
      coverNote: {
        paragraphs: [
          {
            text: 'I am applying for the Technical Account Manager role at Sablecrest. I am a recent Business Information Systems graduate based in London, and I can start immediately.',
            factRefs: ['F34', 'F56', 'F57'],
          },
          {
            text: 'The role involves handling customer technical questions. During my internship at Example Cloud Ltd I resolved 200 support tickets and used Zendesk for customer support. I also led onboarding for 12 clients and cut their time-to-live by 30%.',
            factRefs: ['F11', 'F60', 'F2', 'F3', 'F1'],
          },
          {
            text: 'You also need someone who can present to finance directors. I presented a monthly churn-risk summary to the head of customer success, and I presented the delivery-delay findings from my Olist analysis, where I cleaned 100k orders in Python.',
            factRefs: ['F10', 'F28', 'F27'],
          },
          {
            text: 'I have not administered Salesforce, and I have not managed renewals. I have mapped a customer process in Miro, removed 4 manual handoffs, and I use Zapier. I would be glad to talk about how this fits your accounts.',
            factRefs: ['F8', 'F9', 'F49'],
          },
        ],
      },
    },
    revision: {
      summary: {
        text: 'Recent Business Information Systems graduate with First Class Honours and a customer onboarding internship at a cloud software company. Based in London and available to start immediately.',
        factRefs: ['F34', 'F35', 'F1', 'F56', 'F57'],
      },
      experience: [
        {
          heading: { role: 'Customer Onboarding Intern', org: 'Example Cloud Ltd', factRef: 'F1' },
          bullets: [
            {
              text: 'Led onboarding for 12 clients and cut client time-to-live by 30%.',
              factRefs: ['F2', 'F3'],
            },
            {
              text: 'Presented a monthly churn-risk summary to the head of customer success.',
              factRefs: ['F10'],
            },
            {
              text: 'Resolved 200 support tickets and used Zendesk for customer support.',
              factRefs: ['F11', 'F60'],
            },
            {
              text: 'Mapped the onboarding process in Miro and removed 4 manual handoffs.',
              factRefs: ['F8', 'F9'],
            },
            {
              text: 'Wrote 25 help-centre articles for the self-serve setup flow.',
              factRefs: ['F4'],
            },
            {
              text: 'Logged 40 bug reports in Jira and tracked them through to release.',
              factRefs: ['F6', 'F7'],
            },
          ],
        },
        {
          heading: { role: 'Student Product Analyst', org: 'Campus Apps Society', factRef: 'F12' },
          bullets: [
            {
              text: 'Built a SQL dashboard in Metabase that tracked weekly active users.',
              factRefs: ['F13', 'F14'],
            },
            { text: 'Grew weekly active users by 45%.', factRefs: ['F16'] },
            {
              text: 'Interviewed 18 students to shape the timetable app roadmap.',
              factRefs: ['F15'],
            },
            {
              text: 'Ran an A/B test on the sign-up screen and lifted sign-up completion by 12%.',
              factRefs: ['F20', 'F21'],
            },
            {
              text: 'Wrote user stories and acceptance criteria, and specified requirements for 3 releases.',
              factRefs: ['F18', 'F19'],
            },
          ],
        },
        {
          heading: { role: 'Retail Assistant', org: 'Example Books', factRef: 'F22' },
          bullets: [
            {
              text: 'Handled customer queries on the shop floor and by phone.',
              factRefs: ['F23', 'F24'],
            },
            { text: 'Trained 3 new starters on the till system.', factRefs: ['F25'] },
          ],
        },
      ],
      projects: [
        {
          heading: { role: 'Olist e-commerce analysis', org: 'Personal project', factRef: 'F26' },
          bullets: [
            { text: 'Cleaned 100k orders in Python.', factRefs: ['F27'] },
            {
              text: 'Presented delivery-delay findings from the Olist analysis.',
              factRefs: ['F28'],
            },
          ],
        },
        {
          heading: { role: 'Timetable chatbot prototype', org: 'Personal project', factRef: 'F29' },
          bullets: [
            { text: 'Built a prompt-based FAQ bot with the Claude API.', factRefs: ['F30'] },
          ],
        },
        {
          heading: { role: 'Unity puzzle game', org: 'Personal project', factRef: 'F31' },
          bullets: [
            {
              text: 'Designed a small puzzle game in Unity and shipped it to itch.io.',
              factRefs: ['F32', 'F33'],
            },
          ],
        },
      ],
      education: [
        { line: 'BSc Business Information Systems, Example University', factRef: 'F34' },
        { line: 'Google Data Analytics Certificate', factRef: 'F37' },
        { line: 'Scrum Fundamentals Certificate', factRef: 'F38' },
      ],
      skills: [
        { label: 'SQL', factRefs: ['F39'] },
        { label: 'Python', factRefs: ['F40'] },
        { label: 'Excel', factRefs: ['F41'] },
        { label: 'Metabase', factRefs: ['F42'] },
        { label: 'Jira', factRefs: ['F43'] },
        { label: 'Miro', factRefs: ['F48'] },
        { label: 'Zapier', factRefs: ['F49'] },
        { label: 'Process mapping', factRefs: ['F52'] },
        { label: 'User interviews', factRefs: ['F50'] },
        { label: 'A/B test analysis', factRefs: ['F51'] },
      ],
      coverNote: {
        paragraphs: [
          {
            text: 'I am applying for the Technical Account Manager role at Sablecrest. I am a recent Business Information Systems graduate based in London, and I can start immediately.',
            factRefs: ['F34', 'F56', 'F57'],
          },
          {
            text: 'The role involves handling customer technical questions. During my internship at Example Cloud Ltd I resolved 200 support tickets and used Zendesk for customer support. I also ran onboarding for 12 clients and cut their time-to-live by 30%.',
            factRefs: ['F11', 'F60', 'F2', 'F3', 'F1'],
          },
          {
            text: 'You also need someone who can present to finance directors. I presented a monthly churn-risk summary to the head of customer success, and I presented the delivery-delay findings from my Olist analysis, where I cleaned 100k orders in Python.',
            factRefs: ['F10', 'F28', 'F27'],
          },
          {
            text: 'I have no Salesforce administration or renewals experience yet. I have mapped a customer process in Miro, removed 4 manual handoffs, and I use Zapier. I would be glad to talk about how this fits your accounts.',
            factRefs: ['F8', 'F9', 'F49'],
          },
        ],
      },
    },
  },
  c05: {
    draft: {
      summary: {
        text: 'Recent graduate with a First Class BSc in Business Information Systems. Designed and shipped a small puzzle game in Unity to itch.io, and worked as a product analyst and onboarding intern.',
        factRefs: ['F35', 'F34', 'F32', 'F33', 'F12', 'F1'],
      },
      experience: [
        {
          heading: { role: 'Student Product Analyst', org: 'Campus Apps Society', factRef: 'F12' },
          bullets: [
            {
              text: 'Wrote user stories and acceptance criteria, and specified requirements for 3 releases.',
              factRefs: ['F18', 'F19'],
            },
            {
              text: 'Prioritised the backlog with the student developers every sprint.',
              factRefs: ['F17'],
            },
            {
              text: 'Ran an A/B test on the sign-up screen and lifted sign-up completion by 12%.',
              factRefs: ['F20', 'F21'],
            },
            {
              text: 'Interviewed 18 students to shape the timetable app roadmap.',
              factRefs: ['F15'],
            },
            {
              text: 'Built a SQL dashboard in Metabase that tracked weekly active users.',
              factRefs: ['F13', 'F14'],
            },
          ],
        },
        {
          heading: { role: 'Customer Onboarding Intern', org: 'Example Cloud Ltd', factRef: 'F1' },
          bullets: [
            {
              text: 'Logged 40 bug reports in Jira and tracked bug reports through to release.',
              factRefs: ['F6', 'F7'],
            },
            {
              text: 'Ran weekly product feedback sessions with the support team.',
              factRefs: ['F5'],
            },
            {
              text: 'Mapped the onboarding process in Miro and removed 4 manual handoffs.',
              factRefs: ['F8', 'F9'],
            },
          ],
        },
      ],
      projects: [
        {
          heading: { role: 'Unity puzzle game', org: 'Personal project', factRef: 'F31' },
          bullets: [
            { text: 'Designed a small puzzle game in Unity.', factRefs: ['F32'] },
            { text: 'Shipped the Unity game to itch.io.', factRefs: ['F33'] },
          ],
        },
        {
          heading: { role: 'Timetable chatbot prototype', org: 'Personal project', factRef: 'F29' },
          bullets: [
            { text: 'Built a prompt-based FAQ bot with the Claude API.', factRefs: ['F30'] },
          ],
        },
        {
          heading: { role: 'Olist e-commerce analysis', org: 'Personal project', factRef: 'F26' },
          bullets: [
            {
              text: 'Cleaned 100k orders in Python and presented delivery-delay findings.',
              factRefs: ['F27', 'F28'],
            },
          ],
        },
      ],
      education: [
        { line: 'BSc Business Information Systems, Example University', factRef: 'F34' },
        { line: 'Scrum Fundamentals Certificate', factRef: 'F38' },
        { line: 'Google Data Analytics Certificate', factRef: 'F37' },
      ],
      skills: [
        { label: 'Unity', factRefs: ['F46'] },
        { label: 'Git', factRefs: ['F47'] },
        { label: 'Python', factRefs: ['F40'] },
        { label: 'SQL', factRefs: ['F39'] },
        { label: 'Jira', factRefs: ['F43'] },
        { label: 'Figma', factRefs: ['F44'] },
        { label: 'Miro', factRefs: ['F48'] },
        { label: 'Requirements writing', factRefs: ['F53'] },
        { label: 'A/B test analysis', factRefs: ['F51'] },
        { label: 'User interviews', factRefs: ['F50'] },
      ],
      coverNote: {
        paragraphs: [
          {
            text: 'I am applying for the Junior Unity Developer role at Thistledown Games. You ask for a shipped small game and the ability to talk through its design decisions. I designed a small puzzle game in Unity and shipped it to itch.io, so I can speak about how the puzzle mechanics came together.',
            factRefs: ['F32', 'F33', 'F31'],
          },
          {
            text: 'You also want someone who works well with designers and artists. As a Student Product Analyst I prioritised the backlog with the student developers every sprint, wrote user stories and acceptance criteria, and specified requirements for 3 releases. I also ran an A/B test on the sign-up screen that lifted sign-up completion by 12%.',
            factRefs: ['F12', 'F17', 'F18', 'F19', 'F20', 'F21'],
          },
          {
            text: 'I have not yet written C# professionally, and I would be learning your codebase from the start. I use Git and Unity, and I graduated with First Class Honours in Business Information Systems. I am based in London and available to start immediately.',
            factRefs: ['F46', 'F47', 'F35', 'F34', 'F56', 'F57'],
          },
        ],
      },
    },
    revision: {
      summary: {
        text: 'Recent graduate with a First Class BSc in Business Information Systems. Designed and shipped a small puzzle game in Unity to itch.io, and worked as a product analyst and onboarding intern.',
        factRefs: ['F35', 'F34', 'F32', 'F33', 'F12', 'F1'],
      },
      experience: [
        {
          heading: { role: 'Customer Onboarding Intern', org: 'Example Cloud Ltd', factRef: 'F1' },
          bullets: [
            {
              text: 'Logged 40 bug reports in Jira and tracked bug reports through to release.',
              factRefs: ['F6', 'F7'],
            },
            {
              text: 'Ran weekly product feedback sessions with the support team.',
              factRefs: ['F5'],
            },
            {
              text: 'Mapped the onboarding process in Miro and removed 4 manual handoffs.',
              factRefs: ['F8', 'F9'],
            },
            {
              text: 'Ran onboarding for 12 clients and cut client time-to-live by 30%.',
              factRefs: ['F2', 'F3'],
            },
            {
              text: 'Wrote 25 help-centre articles for the self-serve setup flow.',
              factRefs: ['F4'],
            },
            { text: 'Resolved 200 support tickets using Zendesk.', factRefs: ['F11', 'F60'] },
          ],
        },
        {
          heading: { role: 'Student Product Analyst', org: 'Campus Apps Society', factRef: 'F12' },
          bullets: [
            {
              text: 'Wrote user stories and acceptance criteria, and specified requirements for 3 releases.',
              factRefs: ['F18', 'F19'],
            },
            {
              text: 'Prioritised the backlog with the student developers every sprint.',
              factRefs: ['F17'],
            },
            {
              text: 'Ran an A/B test on the sign-up screen and lifted sign-up completion by 12%.',
              factRefs: ['F20', 'F21'],
            },
            {
              text: 'Interviewed 18 students to shape the timetable app roadmap.',
              factRefs: ['F15'],
            },
            {
              text: 'Built a SQL dashboard in Metabase that tracked weekly active users, which grew by 45%.',
              factRefs: ['F13', 'F14', 'F16'],
            },
          ],
        },
      ],
      projects: [
        {
          heading: { role: 'Unity puzzle game', org: 'Personal project', factRef: 'F31' },
          bullets: [
            { text: 'Designed a small puzzle game in Unity.', factRefs: ['F32'] },
            { text: 'Shipped the Unity game to itch.io.', factRefs: ['F33'] },
          ],
        },
        {
          heading: { role: 'Timetable chatbot prototype', org: 'Personal project', factRef: 'F29' },
          bullets: [
            { text: 'Built a prompt-based FAQ bot with the Claude API.', factRefs: ['F30'] },
          ],
        },
        {
          heading: { role: 'Olist e-commerce analysis', org: 'Personal project', factRef: 'F26' },
          bullets: [
            {
              text: 'Cleaned 100k orders in Python and presented delivery-delay findings from the analysis.',
              factRefs: ['F27', 'F28'],
            },
          ],
        },
      ],
      education: [
        { line: 'BSc Business Information Systems, Example University', factRef: 'F34' },
        { line: 'Google Data Analytics Certificate', factRef: 'F37' },
        { line: 'Scrum Fundamentals Certificate', factRef: 'F38' },
      ],
      skills: [
        { label: 'Unity', factRefs: ['F46'] },
        { label: 'Git', factRefs: ['F47'] },
        { label: 'Python', factRefs: ['F40'] },
        { label: 'SQL', factRefs: ['F39'] },
        { label: 'Jira', factRefs: ['F43'] },
        { label: 'Figma', factRefs: ['F44'] },
        { label: 'Miro', factRefs: ['F48'] },
        { label: 'Requirements writing', factRefs: ['F53'] },
        { label: 'A/B test analysis', factRefs: ['F51'] },
        { label: 'User interviews', factRefs: ['F50'] },
      ],
      coverNote: {
        paragraphs: [
          {
            text: 'I am applying for the Junior Unity Developer role at Thistledown Games. You ask for a shipped small game and the ability to talk through its design decisions. I designed a small puzzle game in Unity and shipped it to itch.io, so I can speak about how the puzzle mechanics came together.',
            factRefs: ['F32', 'F33', 'F31'],
          },
          {
            text: 'You also want someone who works well with designers and artists. As a Student Product Analyst I prioritised the backlog with the student developers every sprint, wrote user stories and acceptance criteria, and specified requirements for 3 releases. I also ran an A/B test on the sign-up screen that lifted sign-up completion by 12%.',
            factRefs: ['F12', 'F17', 'F18', 'F19', 'F20', 'F21'],
          },
          {
            text: 'I have not yet written C# professionally, and I would be learning your codebase from the start. I use Git and Unity, and I graduated with First Class Honours in Business Information Systems. I am based in London and available to start immediately.',
            factRefs: ['F46', 'F47', 'F35', 'F34', 'F56', 'F57'],
          },
        ],
      },
    },
  },
} as const;
