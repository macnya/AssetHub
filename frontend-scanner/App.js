import { useState, useEffect } from 'react';
import { SafeAreaView, StyleSheet, BackHandler } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import LoginScreen from './screens/LoginScreen';
import HomeScreen from './screens/HomeScreen';
import ScannerScreen from './screens/ScannerScreen';
import AssetDetailScreen from './screens/AssetDetailScreen';
import RecentActivityScreen from './screens/RecentActivityScreen';
import CreateAssetScreen from './screens/CreateAssetScreen';
import AskScreen from './screens/AskScreen';
import OfflineBanner from './components/OfflineBanner';
import { startAutoSync, subscribeToSyncState, processPendingActions } from './offline/syncManager';
import { getAssetByCodeOffline } from './offline/offlineApi';
import { wakeServer } from './api';
import ChangePasswordScreen from './screens/ChangePasswordScreen';

export default function App() {
  const [screen, setScreen] = useState('login'); // 'login' | 'home' | 'scanner' | 'assetDetail' | 'activity' | 'createAsset' | 'ask'
  const [assetData, setAssetData] = useState(null);
  const [scannedCode, setScannedCode] = useState('');
  const [userName, setUserName] = useState('');

  // Render's free tier sleeps after ~15 minutes idle and takes around 50
  // seconds to wake. Without this the first scan of the day appears to hang,
  // and because the offline layer reads a timeout as "no network", those first
  // actions queue when they didn't need to. Firing this at launch means the
  // server is waking while the officer is still typing their password.
  useEffect(() => {
    wakeServer();
  }, []);

  useEffect(() => {
    let unsubscribeSync;
    try {
      unsubscribeSync = startAutoSync();
    } catch (e) {
      console.warn('Failed to start offline sync:', e);
    }

    // If a sync attempt comes back unauthorised, the queued work is still
    // safely on the device — the officer just needs to sign in again before
    // it can be sent. Bounce them to the login screen instead of leaving
    // them on a screen where nothing will save.
    const unsubscribeState = subscribeToSyncState((state) => {
      if (state.needsReauth) setScreen('login');
    });

    return () => {
      unsubscribeSync && unsubscribeSync();
      unsubscribeState && unsubscribeState();
    };
  }, []);

    const handleLoginSuccess = async () => {
    const userJson = await AsyncStorage.getItem('user');
    if (userJson) {
      const user = JSON.parse(userJson);
      setUserName(user.name || '');

      // A temporary password reaches the home screen and then fails on every
      // action, because the server allows only change-password and refresh
      // while the flag is set.
      if (user.must_change_password) {
        setScreen('changePassword');
        return;
      }
    }
    setScreen('home');
    // Anything queued while the session was expired can go now.
    processPendingActions();
  };
  const handleScanSuccess = (data) => {
    setAssetData(data);
    setScreen('assetDetail');
  };

  const handleNotFound = (code) => {
    setScannedCode(code);
    setScreen('createAsset');
  };

  const handleAssetCreated = (asset) => {
    setAssetData({ asset, current_assignment: null });
    setScreen('assetDetail');
  };

  const handleSearchResult = (data) => {
    setAssetData(data);
    setScreen('assetDetail');
  };

  const handleBackToHome = () => {
    setAssetData(null);
    setScannedCode('');
    setScreen('home');
  };

   // Wire the phone's own back gesture/button to the same navigation as the
  // on-screen control. Without this, Android's back closed the whole app from
  // any screen, which is why the small chevron was the only way out.
  useEffect(() => {
    const onBack = () => {
      // changePassword is a wall, not a step: backing out of it lands on a
      // home screen where every action fails with a 403.
      if (screen === 'login' || screen === 'home' || screen === 'changePassword') {
        return false;      // let Android do its thing: leave the app
      }
      handleBackToHome();
      return true;         // handled — don't exit
    };
    const sub = BackHandler.addEventListener('hardwareBackPress', onBack);
    return () => sub.remove();
  }, [screen]);

  const handleRefreshAsset = async () => {
    if (!assetData?.asset?.asset_code) return;
    try {
      const { data } = await getAssetByCodeOffline(assetData.asset.asset_code);
      setAssetData(data);
    } catch {
      // If the refresh itself fails (e.g. offline with nothing cached), just
      // keep showing what we already have rather than clearing the screen.
    }
  };

  const handleLogout = async () => {
    await AsyncStorage.removeItem('token');
    await AsyncStorage.removeItem('user');
    setScreen('login');
  };

  return (
    <SafeAreaView style={styles.container}>
      <OfflineBanner />
      {screen === 'login' && <LoginScreen onLoginSuccess={handleLoginSuccess} />}
      {screen === 'home' && (
        <HomeScreen
          userName={userName}
          onScan={() => setScreen('scanner')}
          onSearchResult={handleSearchResult}
          onViewActivity={() => setScreen('activity')}
          onAsk={() => setScreen('ask')}
          onLogout={handleLogout}
        />
      )}
      {screen === 'changePassword' && (
        <ChangePasswordScreen
          onDone={() => { setScreen('home'); processPendingActions(); }}
          onLogout={handleLogout}
        />
      )}
      {screen === 'scanner' && (
        <ScannerScreen
          onScanSuccess={handleScanSuccess}
          onNotFound={handleNotFound}
          onBack={() => setScreen('home')}
        />
      )}
      {screen === 'createAsset' && (
        <CreateAssetScreen
          scannedCode={scannedCode}
          onCreated={handleAssetCreated}
          onCancel={handleBackToHome}
        />
      )}
      {screen === 'assetDetail' && (
        <AssetDetailScreen assetData={assetData} onBack={handleBackToHome} onRefresh={handleRefreshAsset} />
      )}
      {screen === 'activity' && (
        <RecentActivityScreen onBack={handleBackToHome} />
      )}
      {screen === 'ask' && (
        <AskScreen onBack={handleBackToHome} />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
});