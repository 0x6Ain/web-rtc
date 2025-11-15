import { BrowserRouter, Routes, Route } from 'react-router-dom';
import VideoDisplay from './components/VideoDisplay';
import ScreenShare from './components/ScreenShare';
import './App.css';

function App() {
  return (
    <BrowserRouter>
      <div className="app">
        <Routes>
          <Route path="/" element={<VideoDisplay onDisconnect={() => {}} />} />
          <Route path="/offer" element={<ScreenShare />} />
        </Routes>
      </div>
    </BrowserRouter>
  );
}

export default App;

