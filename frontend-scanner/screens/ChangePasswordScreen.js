import { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Alert, ActivityIndicator, Image } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import api from '../api';

// Shown when an administrator has issued a temporary password.
//
// The server refuses every endpoint except change-password and refresh while
// must_change_password is set, and classifyError treats that 403 as REAUTH —
// so without this screen an officer in that state loops: log in, every scan
// fails, back to the login screen, with nothing telling them why. The admin
// panel has had this screen since the flag existed; the scanner did not.
export default function ChangePasswordScreen({ onDone, onLogout }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async () => {
    if (!current || !next) {
      Alert.alert('Missing info', 'Enter your temporary password and a new one.');
      return;
    }
    if (next !== confirm) {
      Alert.alert('Passwords do not match', 'The new password and confirmation are different.');
      return;
    }
    if (next === current) {
      Alert.alert('Choose a different password', 'The new password must not be the one you were given.');
      return;
    }

    setLoading(true);
    try {
      await api.post('/auth/change-password', { current_password: current, new_password: next });

      // The stored user still carries the old flag. Clearing it here means the
      // app does not bounce straight back to this screen.
      const userJson = await AsyncStorage.getItem('user');
      if (userJson) {
        const user = JSON.parse(userJson);
        await AsyncStorage.setItem('user', JSON.stringify({ ...user, must_change_password: false }));
      }

      onDone();
    } catch (err) {
      // The server's own message carries the password rules, so it is shown
      // rather than replaced with something vaguer.
      const message = err.response?.data?.error || 'Could not change the password. Check your connection.';
      Alert.alert('Not changed', message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.container}>
      <Image source={require('../assets/logo.png')} style={styles.logo} resizeMode="contain" />
      <Text style={styles.title}>Choose a new password</Text>
      <Text style={styles.sub}>
        You were given a temporary password. Replace it before you carry on.
      </Text>

      <TextInput
        style={styles.input}
        placeholder="Temporary password"
        value={current}
        onChangeText={setCurrent}
        secureTextEntry
        autoCapitalize="none"
        placeholderTextColor="#98A1AE"
      />
      <TextInput
        style={styles.input}
        placeholder="New password"
        value={next}
        onChangeText={setNext}
        secureTextEntry
        autoCapitalize="none"
        placeholderTextColor="#98A1AE"
      />
      <TextInput
        style={styles.input}
        placeholder="Confirm new password"
        value={confirm}
        onChangeText={setConfirm}
        secureTextEntry
        autoCapitalize="none"
        placeholderTextColor="#98A1AE"
      />

      <TouchableOpacity style={styles.button} onPress={handleSubmit} disabled={loading}>
        {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Save and continue</Text>}
      </TouchableOpacity>

      {/* A way out that is not "force quit the app" — the officer may have
          signed in as the wrong account. */}
      <TouchableOpacity style={styles.link} onPress={onLogout} disabled={loading}>
        <Text style={styles.linkText}>Sign in as someone else</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', padding: 24 },
  logo: { width: 220, height: 57, alignSelf: 'center', marginBottom: 24 },
  title: { fontSize: 24, fontWeight: 'bold', textAlign: 'center', marginBottom: 8 },
  sub: { fontSize: 15, color: '#5A6472', textAlign: 'center', marginBottom: 32 },
  input: {
    borderWidth: 1, borderColor: '#E4E7EC', borderRadius: 10,
    paddingHorizontal: 14, paddingVertical: 13, marginBottom: 14, fontSize: 16,
    color: '#14181F', backgroundColor: '#FFFFFF',
  },
  button: {
    backgroundColor: '#0A3D4A', borderRadius: 8, padding: 16, alignItems: 'center',
  },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  link: { marginTop: 18, alignItems: 'center' },
  linkText: { color: '#5A6472', fontSize: 15 },
});