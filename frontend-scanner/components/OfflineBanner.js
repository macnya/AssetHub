import { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Alert } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import {
  subscribeToSyncState,
  retryFailed,
  getFailedActions,
  discardAllFailedActions,
} from '../offline/syncManager';

export default function OfflineBanner() {
  const [online, setOnline] = useState(true);
  const [sync, setSync] = useState({ pending: 0, failed: 0, needsReauth: false });

  useEffect(() => {
    const unsubscribeNet = NetInfo.addEventListener((state) => {
      setOnline(!!(state.isConnected && state.isInternetReachable !== false));
    });

    // Push-based: the sync manager tells us when something changes, instead of
    // the previous setInterval that hit SQLite every 3 seconds forever.
    const unsubscribeSync = subscribeToSyncState(setSync);

    return () => {
      unsubscribeNet();
      unsubscribeSync();
    };
  }, []);

  const showFailedDetail = () => {
    const failed = getFailedActions();
    const summary = failed
      .slice(0, 10)
      .map((a) => `• ${a.type}${a.asset_code ? ` ${a.asset_code}` : ''} — ${a.last_error || 'rejected'}`)
      .join('\n');
    const more = failed.length > 10 ? `\n…and ${failed.length - 10} more` : '';

    Alert.alert(
      `${failed.length} action${failed.length === 1 ? '' : 's'} the server rejected`,
      `${summary}${more}\n\nThese have not been saved to the register.`,
      [
        { text: 'Close', style: 'cancel' },
        {
          text: 'Discard',
          style: 'destructive',
          onPress: () =>
            Alert.alert(
              'Discard rejected actions?',
              'This permanently deletes them from this device. They will not appear in the asset register.',
              [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Discard', style: 'destructive', onPress: () => discardAllFailedActions() },
              ]
            ),
        },
        { text: 'Try again', onPress: () => retryFailed() },
      ]
    );
  };

  const { pending, failed, needsReauth } = sync;

  if (online && pending === 0 && failed === 0 && !needsReauth) return null;

  // Most urgent state wins the banner.
  if (needsReauth) {
    return (
      <View style={[styles.banner, styles.reauth]}>
        <Text style={styles.text}>
          Session expired — log in again to sync{pending > 0 ? ` ${pending} saved action${pending === 1 ? '' : 's'}` : ''}
        </Text>
      </View>
    );
  }

  if (failed > 0) {
    return (
      <TouchableOpacity style={[styles.banner, styles.failed]} onPress={showFailedDetail}>
        <Text style={styles.text}>
          {failed} action{failed === 1 ? '' : 's'} rejected — tap to review
        </Text>
      </TouchableOpacity>
    );
  }

  return (
    <View style={[styles.banner, !online ? styles.offline : styles.syncing]}>
      <Text style={styles.text}>
        {!online
          ? pending > 0
            ? `Offline — ${pending} action${pending === 1 ? '' : 's'} waiting to sync`
            : 'Offline — changes will be saved and synced later'
          : `Syncing ${pending} pending action${pending === 1 ? '' : 's'}...`}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: { padding: 8, alignItems: 'center' },
  offline: { backgroundColor: '#b23a3a' },
  syncing: { backgroundColor: '#c98a1d' },
  failed: { backgroundColor: '#8e2f2f' },
  reauth: { backgroundColor: '#0A3D4A' },
  text: { color: '#fff', fontSize: 12, fontWeight: '600' },
});