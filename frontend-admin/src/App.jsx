import { useState, useEffect, useCallback } from 'react';
import './App.css';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import AssetList from './pages/AssetList';
import AssetDetail from './pages/AssetDetail';
import CreateEmployee from './pages/CreateEmployee';
import CreateLocation from './pages/CreateLocation';
import UserManagement from './pages/UserManagement';
import CreateUser from './pages/CreateUser';
import CreateAsset from './pages/CreateAsset';
import VerificationReport from './pages/VerificationReport';
import AssetLocations from './pages/AssetLocation';
import ChangePassword from './pages/ChangePassword';
import Branches from './pages/Branches';
import Approvals from './pages/Approvals';
import { refreshSession, fetchPendingCount } from './api';
import { isAdmin, isFinance, canCreateAssets, canManageRecords, canonicalRole, ROLES } from './roles';
import logo from './assets/logo.png';
import Clearances from './pages/Clearances';
import Assistant from './components/Assistant';
import Finance from './pages/Finance';
import Activity from './pages/Activity';
import Import from './pages/Import';

// `hideForFinance` keeps a role off pages that are not theirs. Finance does not
// need the map or the verification report — showing someone a page they cannot
// act on is noise, and it makes the pages they do need harder to find.
const TABS = [
  { key: 'dashboard',     label: 'Dashboard' },
  { key: 'list',          label: 'Assets' },
  { key: 'finance',       label: 'Finance',       financeOrAdmin: true },
  { key: 'branches',      label: 'Branches' },
  { key: 'locations',     label: 'Map',           hideForFinance: true },
  { key: 'verifications', label: 'Verifications', hideForFinance: true },
  { key: 'activity',      label: 'Activity',      adminOrAuditor: true },
  { key: 'clearances',    label: 'Exit clearance' },
  { key: 'approvals',     label: 'Approvals', adminOnly: true, badge: true },
  { key: 'users',         label: 'Staff accounts', adminOnly: true },
  { key: 'import',        label: 'Import',        adminOnly: true },
];

// One place deciding which tabs a role sees, rather than a condition per tab
// scattered through the render.
function visibleTabs(user) {
  const admin = isAdmin(user);
  const finance = isFinance(user);
  const auditor = canonicalRole(user?.role) === ROLES.AUDITOR;

  return TABS.filter((t) => {
    if (t.adminOnly && !admin) return false;
    if (t.adminOrAuditor && !(admin || auditor)) return false;
    if (t.financeOrAdmin && !(finance || admin)) return false;
    if (t.hideForFinance && finance) return false;
    return true;
  });
}

function App() {
  const [user, setUser] = useState(null);
  const [view, setView] = useState('dashboard');
  const [selectedAssetCode, setSelectedAssetCode] = useState(null);
  const [listInitialStatus, setListInitialStatus] = useState('');
  const [listInitialBranch, setListInitialBranch] = useState('');
  const [changingPassword, setChangingPassword] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pending, setPending] = useState(0);

  useEffect(() => {
    const stored = localStorage.getItem('user');
    if (!stored) return;

    // eslint-disable-next-line react-hooks/set-state-in-effect
    setUser(JSON.parse(stored));

    // The cached copy can be stale — a role change or a forced password reset
    // happens in the database, not in this browser. Refreshing on load also
    // trades the stored token for a fresh 8h one, so a session started in the
    // morning doesn't expire mid-afternoon.
    refreshSession()
      .then((freshUser) => setUser(freshUser))
      .catch(() => {
        // Offline, or the token has already expired — the 401 interceptor in
        // api.js handles that case by clearing storage and reloading.
      });
  }, []);

  // Counted on sign-in and after each review, not on a timer. An admin who has
  // just cleared the queue should see it empty; one who hasn't looked today
  // should see the count waiting for them.
  const refreshPending = useCallback(() => {
    if (!isAdmin(user)) return;
    fetchPendingCount()
      .then((c) => setPending(c.total))
      .catch(() => { /* a missing badge is better than an error banner */ });
  }, [user]);

  useEffect(() => {
    refreshPending();
  }, [refreshPending]);

  const handleLogout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    setUser(null);
  };

  if (!user) return <Login onLoginSuccess={setUser} />;

    // A temporary password stands between them and the app until it's replaced.
  // The backend refuses every other endpoint while the flag is set, so this
  // screen is the only way forward rather than merely the only one offered.
  if (user.must_change_password) {
    return <ChangePassword user={user} forced onDone={setUser} />;
  }

  if (changingPassword) {
    return (
      <ChangePassword
        user={user}
        onDone={(u) => { setUser(u); setChangingPassword(false); }}
        onCancel={() => setChangingPassword(false)}
      />
    );
  }

  // Every navigation closes the menu. On a phone the panel covers the content,
  // so leaving it open after a tap would hide the thing just navigated to.
  const go = (nextView) => { setView(nextView); setMenuOpen(false); };

  const openAsset = (code) => { setSelectedAssetCode(code); setView('detail'); };

  // Both the dashboard tiles and the Branches page open the asset list with a
  // filter already applied, so the numbers you clicked and the rows you land on
  // are the same set.
  const openList = ({ status = '', branch = '' } = {}) => {
    setListInitialStatus(status);
    setListInitialBranch(branch);
    go('list');
  };

  let content;
  if (view === 'detail') {
    content = <AssetDetail assetCode={selectedAssetCode} onBack={() => setView('list')} />;

  } else if (view === 'newEmployee') {
    content = (
      <CreateEmployee onBack={() => setView('list')}
        onCreated={() => { alert('Employee created'); setView('list'); }} />
    );

  } else if (view === 'newLocation') {
    content = (
      <CreateLocation onBack={() => setView('list')}
        onCreated={() => { alert('Location created'); setView('list'); }} />
    );

  } else if (view === 'users') {
    content = isAdmin(user)
      ? <UserManagement currentUserId={user.id} onCreateNew={() => setView('newUser')} />
      : <AccessDenied />;

  } else if (view === 'newUser') {
    content = isAdmin(user)
      ? <CreateUser onBack={() => setView('users')}
          onCreated={() => { alert('Staff account created'); setView('users'); }} />
      : <AccessDenied />;

  } else if (view === 'newAsset') {
    content = (
      <CreateAsset
        onBack={() => setView('list')}
        onCreated={(code) => {
          alert('Asset created. You can now find it in the list and print its barcode.');
          openAsset(code);
        }}
      />
    );
  
  } else if (view === 'finance') {
    content = (isFinance(user) || isAdmin(user))
      ? <Finance scopedTo={user.branch} />
      : <AccessDenied />;

  } else if (view === 'approvals') {
    content = isAdmin(user)
      ? <Approvals onReviewed={refreshPending} onSelectAsset={openAsset} />
      : <AccessDenied />;

  } else if (view === 'branches') {
    content = <Branches onSelectBranch={(branch) => openList({ branch })} />;

  } else if (view === 'clearances') {
    content = <Clearances canManage={isAdmin(user)} onSelectAsset={openAsset} />;

  } else if (view === 'verifications') {
    content = <VerificationReport />;

  } else if (view === 'activity') {
    content = <Activity scopedTo={user.branch} />;

  } else if (view === 'locations') {
    content = <AssetLocations onSelectAsset={openAsset} />;

    } else if (view === 'import') {
    content = isAdmin(user) ? <Import /> : <AccessDenied />;

  } else if (view === 'list') {
    content = (
      <AssetList
        onSelectAsset={openAsset}
        initialStatus={listInitialStatus}
        initialBranch={listInitialBranch}
        canCreate={canCreateAssets(user)}
        canManage={canManageRecords(user)}
        onNewAsset={() => setView('newAsset')}
        onNewEmployee={() => setView('newEmployee')}
        onNewLocation={() => setView('newLocation')}
      />
    );

  } else {
    content = (
      <Dashboard
        onNavigate={(targetView, status) => {
          if (targetView === 'branches') { setView('branches'); return; }
          openList({ status: status || '' });
        }}
      />
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <img src={logo} alt="AssetHub" />
          </div>

          {/* Below 860px the nav and the account controls collapse behind this.
              They were previously wrapping onto the same row and being cut off
              at the right edge. */}
          <button
            className="nav-toggle"
            onClick={() => setMenuOpen((v) => !v)}
            aria-expanded={menuOpen}
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
          >
            <span className={menuOpen ? 'nav-toggle-bars is-open' : 'nav-toggle-bars'} />
          </button>

          <nav className={menuOpen ? 'nav is-open' : 'nav'}>
                        {visibleTabs(user).map((t) => (
              <button
                key={t.key}
                className={view === t.key ? 'nav-item is-active' : 'nav-item'}
                onClick={() => go(t.key)}
              >
                {t.label}
                {t.badge && pending > 0 && <span className="nav-badge">{pending}</span>}
              </button>
            ))}
          </nav>

          <div className={menuOpen ? 'topbar-user is-open' : 'topbar-user'}>
            {user.branch && <span className="badge badge-deep">{user.branch}</span>}

            {/* Plain text, not a button. Clicking your own name and landing on
                a password form is a surprise; the action gets its own control. */}
            <span className="topbar-name" title={`${user.email} · ${user.role}`}>
              {user.name}
            </span>

            <button
              className="btn btn-ghost btn-sm"
              onClick={() => { setChangingPassword(true); setMenuOpen(false); }}
            >
              Change password
            </button>
            <button className="btn btn-secondary btn-sm" onClick={handleLogout}>Log out</button>
          </div>
        </div>
      </header>

      {content}

      {/* Available on every page. The endpoint scopes answers to this user's
          own role and branch, so it shows nothing the panel would not. */}
      <Assistant scopedTo={user.branch} />
    </div>
  );
}

function AccessDenied() {
  return (
    <div className="page">
      <div className="card">
        <div className="card-body">
          <h2>Not available for your role</h2>
          <p className="page-sub">Ask an Admin if you need access to this section.</p>
        </div>
      </div>
    </div>
  );
}

export default App;